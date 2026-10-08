import logging
import queue
import sys
from logging.handlers import QueueHandler, QueueListener
from config import Config

_listener = None


def apply_access_log_setting():
    """Apply the runtime access-log switch for uvicorn request logs."""
    logging.getLogger("uvicorn.access").disabled = not Config.ACCESS_LOG


def _managed_log_level() -> int:
    level_name = str(getattr(Config, "LOG_LEVEL", "INFO") or "INFO").upper()
    return getattr(logging, level_name, logging.INFO)


def apply_log_level_setting():
    """Apply the runtime log-level setting to the queue logger and known noisy loggers."""
    level = _managed_log_level()
    root_logger = logging.getLogger()
    root_logger.setLevel(level)
    for handler in root_logger.handlers:
        handler.setLevel(level)
    if _listener is not None:
        for handler in getattr(_listener, "handlers", []):
            handler.setLevel(level)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "httpx", "httpcore"):
        logger = logging.getLogger(name)
        logger.setLevel(logging.WARNING if name in {"httpx", "httpcore"} else level)


class AIGCFormatter(logging.Formatter):
    """Custom log formatter that adds level icons for better readability."""

    LEVEL_ICONS = {
        "DEBUG": ".",
        "INFO": "i",
        "WARNING": "!",
        "ERROR": "x",
        "CRITICAL": "X",
    }

    LEVEL_COLORS = {
        "DEBUG": "\033[90m",
        "INFO": "\033[36m",
        "WARNING": "\033[33m",
        "ERROR": "\033[31m",
        "CRITICAL": "\033[1;37;41m",
    }
    RESET = "\033[0m"

    def __init__(self, *args, use_color=False, **kwargs):
        super().__init__(*args, **kwargs)
        self.use_color = use_color

    def format(self, record: logging.LogRecord) -> str:
        record.level_icon = self.LEVEL_ICONS.get(record.levelname, record.levelname[:1])
        if self.use_color:
            color = self.LEVEL_COLORS.get(record.levelname)
            if color:
                record.level_icon = f"{color}{record.level_icon}{self.RESET}"
                record.levelname = f"{color}{record.levelname}{self.RESET}"
        return super().format(record)


def setup_concurrent_logging():
    """Configure queue-based logging so worker threads do not interleave output."""
    global _listener
    if _listener is not None:
        return _listener

    level = _managed_log_level()

    log_queue = queue.Queue(-1)
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(level)
    console_handler.setFormatter(AIGCFormatter(
        "%(asctime)s | %(level_icon)s %(levelname)-7s | %(name)s:%(lineno)d | %(message)s",
        datefmt="%H:%M:%S",
        use_color=sys.stdout.isatty(),
    ))

    listener = QueueListener(log_queue, console_handler, respect_handler_level=True)
    listener.start()

    queue_handler = QueueHandler(log_queue)
    root_logger = logging.getLogger()
    root_logger.setLevel(level)
    root_logger.handlers.clear()
    root_logger.addHandler(queue_handler)

    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "httpx", "httpcore"):
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True
        logger.setLevel(logging.WARNING if name in {"httpx", "httpcore"} else level)
    apply_log_level_setting()
    apply_access_log_setting()

    _listener = listener
    return listener
