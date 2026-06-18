"""Re-export Repository from the persistence layer for backward-compatible imports."""

from engine.sdk.persistence.base import Repository
from engine.sdk.persistence.sqlite_repository import SQLiteRepository

__all__ = ["Repository", "SQLiteRepository"]
