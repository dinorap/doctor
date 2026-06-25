"""Flow Kit SDK — high-level domain-model interface."""

from engine.sdk.models.base import DomainModel
from engine.sdk.persistence.sqlite_repository import SQLiteRepository
from engine.sdk.services.operations import init_operations, OperationService


def init_sdk(flow_client) -> OperationService:
    """Bootstrap the SDK: create repo, wire into DomainModel, return OperationService."""
    repo = SQLiteRepository()
    return init_operations(flow_client, repo)
