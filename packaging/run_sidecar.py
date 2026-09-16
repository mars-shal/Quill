"""Entry point for the packaged sidecar.

server.py lives inside the quill_engine.api package and uses relative
imports, so it cannot be executed as a bare script. PyInstaller bundles
this launcher instead; it imports the package and hands over to the
same main() the venv path uses (uvicorn.run(create_app(), ...)).
"""

from quill_engine.api.server import main

if __name__ == "__main__":
    main()