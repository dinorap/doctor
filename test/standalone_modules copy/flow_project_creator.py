"""
Flow Project Creator - Standalone Module
Module tạo project trên Google Flow và lưu vào database.
"""
import logging
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)


class FlowProjectCreator:
    """Service tạo project trên Google Flow."""
    
    def __init__(self, flow_client, db_adapter=None):
        """
        Args:
            flow_client: Instance của FlowClientWrapper
            db_adapter: Optional database adapter (có methods: save_project, save_character, link_character)
        """
        self.client = flow_client
        self.db = db_adapter
    
    async def create_project(
        self,
        name: str,
        description: Optional[str] = None,
        story: Optional[str] = None,
        material: str = "3d_pixar",
        tool_name: str = "PINHOLE",
        characters: Optional[list[Dict[str, Any]]] = None,
    ) -> dict:
        """
        Tạo project mới trên Google Flow.
        
        Args:
            name: Tên project
            description: Mô tả ngắn
            story: Câu chuyện đầy đủ
            material: Material/style (3d_pixar, realistic, anime, etc.)
            tool_name: Tool name cho Flow API
            characters: List các character cần tạo
                       [{"name": "...", "description": "...", "entity_type": "character"}]
        
        Returns:
            dict: Project info với Flow projectId
        """
        # Step 1: Validate client connection
        if not self.client.connected:
            raise Exception("Flow client not connected")
        
        # Step 2: Detect user tier
        tier = await self._detect_tier()
        
        # Step 3: Create project on Google Flow
        logger.info(f"Creating project on Flow: {name}")
        flow_result = await self.client.create_project(name, tool_name)
        
        if flow_result.get("error"):
            raise Exception(f"Flow API error: {flow_result['error']}")
        
        # Parse projectId từ response
        try:
            data = flow_result.get("data", {})
            result = data["result"]["data"]["json"]["result"]
            project_id = result["projectId"]
        except (KeyError, TypeError) as e:
            raise Exception(f"Failed to parse Flow response: {e}")
        
        logger.info(f"Flow project created: {project_id}")
        
        # Step 4: Save to local database (nếu có db_adapter)
        project_data = {
            "id": project_id,
            "name": name,
            "description": description,
            "story": story,
            "material": material,
            "user_paygate_tier": tier,
        }
        
        if self.db and hasattr(self.db, 'save_project'):
            await self.db.save_project(project_data)
        
        # Step 5: Create characters (nếu có)
        if characters and self.db:
            for char in characters:
                char_data = {
                    "name": char["name"],
                    "description": char.get("description", ""),
                    "entity_type": char.get("entity_type", "character"),
                    "voice_description": char.get("voice_description"),
                }
                
                if hasattr(self.db, 'save_character'):
                    char_id = await self.db.save_character(char_data)
                    
                    if hasattr(self.db, 'link_character'):
                        await self.db.link_character(project_id, char_id)
                        logger.info(f"Character '{char['name']}' linked to project")
        
        return project_data
    
    async def _detect_tier(self) -> str:
        """Auto-detect user paygate tier."""
        try:
            result = await self.client.get_credits()
            data = result.get("data", result)
            tier = data.get("userPaygateTier", "PAYGATE_TIER_ONE")
            logger.info(f"Detected tier: {tier}")
            return tier
        except Exception as e:
            logger.warning(f"Failed to detect tier: {e}, using TIER_ONE")
            return "PAYGATE_TIER_ONE"
