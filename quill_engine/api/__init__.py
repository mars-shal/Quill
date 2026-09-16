"""Local HTTP/WS API server binding quill_engine to the desktop GUI.

The GUI (Electron renderer) talks to this sidecar over 127.0.0.1 only;
engine calls run on worker threads and report through WebSocket events
(see ``.agent/master.md`` §Frontend for the original service-split plan).
"""
