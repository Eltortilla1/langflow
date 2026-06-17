"""Tests that bare lfx registers lean default storage/variable factories.

Without these factories, ``get_storage_service()`` / ``get_variable_service()``
return ``None`` in a process without langflow and file-backed or variable-using
components hit ``AttributeError``. These tests verify the defaults are wired up,
usable, and overridable through the same service manager.
"""

import lfx.services.manager as manager_mod
import pytest
from lfx.services.factory import ServiceFactory
from lfx.services.manager import ServiceManager
from lfx.services.schema import ServiceType
from lfx.services.storage.factory import StorageServiceFactory
from lfx.services.storage.local import LocalStorageService
from lfx.services.variable.factory import VariableServiceFactory
from lfx.services.variable.service import VariableService


@pytest.fixture
def fresh_service_manager(monkeypatch):
    """Swap the global service manager for a fresh one (auto-restored)."""
    import asyncio

    new_manager = ServiceManager()
    monkeypatch.setattr(manager_mod, "_service_manager", new_manager)
    yield new_manager
    asyncio.run(new_manager.teardown())


def test_factories_carry_expected_metadata():
    """The lean defaults are no-deps (variable) / settings-only (storage)."""
    storage_factory = StorageServiceFactory()
    variable_factory = VariableServiceFactory()

    assert storage_factory.service_class is LocalStorageService
    assert storage_factory.dependencies == [ServiceType.SETTINGS_SERVICE]

    assert variable_factory.service_class is VariableService
    assert variable_factory.dependencies == []


def test_get_storage_and_variable_services_are_not_none(fresh_service_manager):
    """In a process without langflow the deps helpers return real services."""
    from lfx.services.deps import get_storage_service, get_variable_service
    from lfx.services.initialize import initialize_services

    initialize_services()

    storage = get_storage_service()
    variables = get_variable_service()

    assert storage is not None
    assert isinstance(storage, LocalStorageService)
    assert variables is not None
    assert isinstance(variables, VariableService)

    # The deps helpers resolve through the (isolated) global manager.
    assert fresh_service_manager.get(ServiceType.STORAGE_SERVICE) is storage
    assert fresh_service_manager.get(ServiceType.VARIABLE_SERVICE) is variables


@pytest.mark.asyncio
async def test_default_storage_service_saves_and_reads_file(fresh_service_manager, monkeypatch, tmp_path):
    """A file-backed flow can save and read a file via the default storage service."""
    monkeypatch.setenv("LANGFLOW_CONFIG_DIR", str(tmp_path))

    from lfx.services.deps import get_storage_service
    from lfx.services.initialize import initialize_services

    initialize_services()
    assert ServiceType.STORAGE_SERVICE.value in fresh_service_manager.factories

    storage = get_storage_service()
    assert storage is not None  # would be None (AttributeError on use) before the fix

    await storage.save_file("flow_1", "data.txt", b"hello")
    assert await storage.get_file("flow_1", "data.txt") == b"hello"


def test_registering_a_different_storage_factory_overrides_default(fresh_service_manager):
    """A different storage factory registered through the manager wins."""
    from lfx.services.base import Service
    from lfx.services.initialize import initialize_services

    initialize_services()

    class CustomStorageService(Service):
        # Same name keys it to STORAGE_SERVICE and replaces the default factory.
        name = "storage_service"

        def __init__(self) -> None:
            super().__init__()
            self.set_ready()

        async def teardown(self) -> None:
            pass

    class CustomStorageFactory(ServiceFactory):
        def __init__(self) -> None:
            super().__init__()
            self.service_class = CustomStorageService
            self.dependencies = []

        def create(self):
            return CustomStorageService()

    fresh_service_manager.register_factory(CustomStorageFactory())

    service = fresh_service_manager.get(ServiceType.STORAGE_SERVICE)
    assert isinstance(service, CustomStorageService)
    assert not isinstance(service, LocalStorageService)
