from utilis.timing import timed
import json
import os

from pydantic import BaseModel


class JsonDatabase:
    def __init__(self, file_path: str = "database/database.json"):
        self.file_path = file_path
        self._ensure_db_exists()

    def _ensure_db_exists(self):
        # Create directory if it doesn't exist
        os.makedirs(os.path.dirname(self.file_path), exist_ok=True)

        # Create file with empty object if it doesn't exist
        if not os.path.exists(self.file_path):
            self._save({})
        else:
            # Verify it's valid JSON
            try:
                self._load()
            except (json.JSONDecodeError, ValueError):
                self._save({})

    def _load(self) -> Dict[str, Any]:
        if not os.path.exists(self.file_path):
            return {}
        with open(self.file_path, "r") as f:
            return json.load(f)

    def _save(self, data: Dict[str, Any]):
        with open(self.file_path, "w") as f:
            json.dump(data, f, indent=4)

    @timed("JsonDatabase.get")
    def get(self, key: str, default: Any = None) -> Any:
        data = self._load()
        return data.get(key, default)

    @timed("JsonDatabase.set")
    def set(self, key: str, value: Any) -> None:
        data = self._load()
        if isinstance(value, BaseModel):
            data[key] = value.model_dump()
        else:
            data[key] = value
        self._save(data)

    @timed("JsonDatabase.delete")
    def delete(self, key: str) -> bool:
        data = self._load()
        if key in data:
            del data[key]
            self._save(data)
            return True
        return False

    @timed("JsonDatabase.list_keys")
    def list_keys(self) -> list:
        return list(self._load().keys())
