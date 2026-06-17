"""
Example: Tạo project mới trên Google Flow
"""
import asyncio
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from flow_client_wrapper import FlowClientWrapper
from flow_project_creator import FlowProjectCreator


async def main():
    # Step 1: Khởi tạo client
    client = FlowClientWrapper()
    
    # Note: Trong production, bạn cần:
    # - Set WebSocket connection từ Chrome Extension
    # - Set Flow API key
    # client.set_websocket(ws)
    # client.set_flow_key("your_flow_key")
    
    # Step 2: Khởi tạo project creator
    creator = FlowProjectCreator(client, db_adapter=None)
    
    # Step 3: Tạo project
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
        
        print(f"✅ Project created successfully!")
        print(f"Project ID: {project['id']}")
        print(f"Name: {project['name']}")
        print(f"Tier: {project['user_paygate_tier']}")
        
    except Exception as e:
        print(f"❌ Error: {e}")


if __name__ == "__main__":
    asyncio.run(main())
