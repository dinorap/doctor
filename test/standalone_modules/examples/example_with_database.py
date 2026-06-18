"""
Example: Sử dụng với custom database adapter
"""
import asyncio
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from flow_client_wrapper import FlowClientWrapper
from flow_project_creator import FlowProjectCreator


class SimpleDBAdapter:
    """
    Example database adapter.
    Bạn có thể implement theo database của bạn (SQLite, PostgreSQL, MongoDB, etc.)
    """
    
    def __init__(self):
        self.projects = {}
        self.characters = {}
        self.links = []
    
    async def save_project(self, project_data: dict):
        """Lưu project vào database."""
        project_id = project_data['id']
        self.projects[project_id] = project_data
        print(f"💾 Saved project to DB: {project_id}")
    
    async def save_character(self, character_data: dict) -> str:
        """Lưu character vào database, return character ID."""
        char_id = f"char_{len(self.characters) + 1}"
        character_data['id'] = char_id
        self.characters[char_id] = character_data
        print(f"💾 Saved character to DB: {char_id} - {character_data['name']}")
        return char_id
    
    async def link_character(self, project_id: str, character_id: str):
        """Link character với project."""
        self.links.append((project_id, character_id))
        print(f"🔗 Linked {character_id} to project {project_id}")
    
    def get_project(self, project_id: str):
        """Lấy project từ database."""
        return self.projects.get(project_id)
    
    def get_characters_for_project(self, project_id: str):
        """Lấy all characters của một project."""
        char_ids = [cid for pid, cid in self.links if pid == project_id]
        return [self.characters[cid] for cid in char_ids if cid in self.characters]


async def main():
    # Step 1: Khởi tạo client
    client = FlowClientWrapper()
    
    # Note: Trong production, bạn cần:
    # client.set_websocket(ws)
    # client.set_flow_key("your_flow_key")
    
    # Step 2: Khởi tạo database adapter
    db = SimpleDBAdapter()
    
    # Step 3: Khởi tạo project creator với DB adapter
    creator = FlowProjectCreator(client, db_adapter=db)
    
    # Step 4: Tạo project với characters
    try:
        project = await creator.create_project(
            name="Project with Database",
            description="Testing database integration",
            story="A story about brave heroes",
            characters=[
                {
                    "name": "Hero",
                    "description": "The main protagonist",
                    "entity_type": "character",
                },
                {
                    "name": "Villain",
                    "description": "The main antagonist",
                    "entity_type": "character",
                }
            ]
        )
        
        project_id = project['id']
        
        print(f"\n✅ Project created with database!")
        print(f"Project ID: {project_id}")
        
        # Step 5: Query lại từ database
        print("\n📊 Querying from database...")
        saved_project = db.get_project(project_id)
        print(f"Project name: {saved_project['name']}")
        
        characters = db.get_characters_for_project(project_id)
        print(f"Characters ({len(characters)}):")
        for char in characters:
            print(f"  - {char['name']}: {char['description']}")
        
    except Exception as e:
        print(f"❌ Error: {e}")


if __name__ == "__main__":
    asyncio.run(main())
