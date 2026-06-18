"""
Example: Tạo project mới trên Google Flow với kiểm tra kết quả chi tiết.
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from flow_client_wrapper import FlowClientWrapper
from flow_project_creator import FlowProjectCreator, FlowProjectCreationError


async def main():
    client = FlowClientWrapper()

    if not client.connected:
        print("❌ Flow client chưa kết nối. Kiểm tra cấu hình Flow API key.")
        return

    creator = FlowProjectCreator(client, db_adapter=None)

    try:
        project = await creator.create_project(
            name="My Test Project",
            description="A test project created via standalone module",
            story="This is a demo story for testing purposes.",
            material="3d_pixar",
            characters=[
                {
                    "name": "Alice",
                    "description": "A brave adventurer",
                    "entity_type": "character",
                },
                {
                    "name": "Bob",
                    "description": "A wise mentor",
                    "entity_type": "character",
                }
            ]
        )

        print("=" * 50)
        print(creator.get_project_summary(project))
        print("=" * 50)
        print(f"\n📋 Full project data:")
        for key, value in project.items():
            if key not in ("flow_response",):
                print(f"  {key}: {value}")

        if project.get("flow_response"):
            print(f"\n🔗 Flow response available (use project['flow_response'] for raw API data)")

    except FlowProjectCreationError as e:
        print(f"❌ FlowProjectCreationError:")
        print(f"   Step: {e.step}")
        print(f"   Message: {e}")
        if e.details:
            print(f"   Details: {e.details}")
    except Exception as e:
        print(f"❌ Unexpected error: {e}")


if __name__ == "__main__":
    asyncio.run(main())
