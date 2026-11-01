# Execute notebooks in forks of one process, which has already imported what they
# all need, so that each doesn't spend seconds starting Python and importing the
# same modules. Each notebook still gets a new process and a new kernel, which
# talk over the Jupyter protocol as usual.
#
# Used by `quarto render --jobs` (see executeKernelPrefork in jupyter-kernel.ts).
# Nothing here may start a thread or a socket before forking, apart from the
# server's own socket.

import ctypes
import importlib
import json
import os
import signal
import socketserver
import stat
import sys
import time
import uuid

from log import trace, log_error
from nbclient.exceptions import CellExecutionError
from notebook import notebook_execute, notebook_init

import jupyter_client.provisioning.local_provisioner as local_provisioner

# What any kernel imports, whether or not a project preloads anything else
KERNEL_MODULES = [
    "ipykernel.ipkernel",
    "ipykernel.kernelapp",
]

launch_process = local_provisioner.launch_kernel


class ForkedKernel:
    """The parts of subprocess.Popen that jupyter_client uses"""

    stdin = stdout = stderr = None

    def __init__(self, pid):
        self.pid = pid
        self.returncode = None

    def poll(self):
        if self.returncode is None:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.returncode = os.waitstatus_to_exitcode(status)
        return self.returncode

    def wait(self, timeout=None):
        while self.poll() is None:
            time.sleep(0.01)
        return self.returncode

    def send_signal(self, signum):
        if self.returncode is None:
            os.kill(self.pid, signum)

    def kill(self):
        self.send_signal(signal.SIGKILL)

    def terminate(self):
        self.send_signal(signal.SIGTERM)


def kernel_main(read_fd):
    """Run in the kernel's process: wait to be told how to start, then be the kernel"""
    os.setsid()  # Before jupyter_client asks for the process group, to signal it
    if sys.platform == "linux":  # ipykernel only notices a parent that exits under init
        PR_SET_PDEATHSIG = 1
        ctypes.CDLL(None).prctl(PR_SET_PDEATHSIG, signal.SIGKILL)
    with os.fdopen(read_fd) as pipe:
        request = pipe.read()
    if not request:  # The notebook didn't need a kernel
        os._exit(0)
    request = json.loads(request)

    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in [0, 1, 2]:
        os.dup2(devnull, fd)
    os.closerange(3, 4096)
    os.environ.clear()
    os.environ.update(request["env"])
    os.chdir(request["cwd"])

    # This connects itself to the kernel when imported, so it can't be preloaded
    sys.modules.pop("matplotlib_inline.backend_inline", None)

    from ipykernel.kernelapp import IPKernelApp

    try:
        IPKernelApp.launch_instance(argv=request["argv"])
    finally:
        os._exit(0)


def prefork_kernel():
    """
    Fork the process for this notebook's kernel, for jupyter_client to start later.
    This happens first because by then there's an event loop running, which the
    kernel shouldn't inherit.
    """
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(write_fd)
        kernel_main(read_fd)
    os.close(read_fd)
    process = ForkedKernel(pid)

    def launch_kernel(cmd, env=None, cwd=None, **kwargs):
        same_python = os.path.realpath(cmd[0]) == os.path.realpath(sys.executable)
        if not same_python or "ipykernel_launcher" not in cmd:
            os.close(write_fd)
            return launch_process(cmd, env=env, cwd=cwd, **kwargs)
        argv = cmd[cmd.index("ipykernel_launcher") + 1 :]
        with os.fdopen(write_fd, "w") as pipe:
            json.dump(dict(argv=argv, env=env or dict(os.environ), cwd=cwd or os.getcwd()), pipe)
        return process

    local_provisioner.launch_kernel = launch_kernel


class ExecuteHandler(socketserver.StreamRequestHandler):
    def handle(self):
        request = json.loads(self.rfile.readline())
        if request["secret"] != self.server.secret:
            return
        if request["command"] == "file":
            filename = request["options"]["file"]
            with open(filename, "r", encoding="utf8") as file:
                request = json.load(file)
            os.unlink(filename)

        options = request["options"]
        os.environ.update(options.get("executeEnv") or {})

        def status(msg):
            self.message("status", msg)

        try:
            prefork_kernel()
            notebook_execute(options, status)
        except CellExecutionError as e:
            msg = str(e)
            marker = "nbclient.exceptions.CellExecutionError: "
            loc = msg.find(marker)
            self.message("error", "\n\n" + (msg[loc + len(marker) :] if loc != -1 else msg))
        except Exception as e:
            log_error("Unable to run notebook", exc_info=e)
            self.message("error", "\n\n" + str(e))
        finally:
            if hasattr(notebook_init, "client"):
                notebook_init.client._cleanup_kernel()

    def message(self, type, data=""):
        self.wfile.write(bytearray(json.dumps(dict(type=type, data=data)) + "\n", "utf-8"))
        self.wfile.flush()


class ExecuteServer(socketserver.ForkingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    block_on_close = False
    request_queue_size = 128
    max_children = 4096

    def __init__(self, options):
        self.secret = str(uuid.uuid4())
        self.parent_pid = options["parent_pid"]
        super().__init__(("localhost", 0), ExecuteHandler)

        # Listen before importing, so that the first notebooks just wait in the queue
        transport = options["transport"]
        port = self.socket.getsockname()[1]
        with open(transport, "w") as file:
            file.write("")
        os.chmod(transport, stat.S_IRUSR | stat.S_IWUSR)
        with open(transport, "w") as file:
            file.write(json.dumps(dict(port=port, secret=self.secret)))

    def service_actions(self):
        """Don't outlive the render"""
        super().service_actions()
        try:
            os.kill(self.parent_pid, 0)
        except ProcessLookupError:
            trace("render has ended (exiting server)")
            os.killpg(0, signal.SIGTERM)


def run_prefork_server(options):
    with ExecuteServer(options) as server:
        for name in KERNEL_MODULES + options.get("preload", []):
            trace(f"preloading {name}")
            try:
                importlib.import_module(name)
            except Exception as e:
                # The notebook that needs this will give the error, if any does
                trace(f"could not preload {name}: {e}")
        server.serve_forever(poll_interval=0.5)
