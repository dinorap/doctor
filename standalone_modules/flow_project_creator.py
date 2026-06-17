"""
Flow Project Creator - Standalone Module
Module tạo project trên Google Flow và lưu vào database.
"""
import logging
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List

logger = logging.getLogger(__name__)


class FlowProjectCreationError(Exception):
    """Raised when project creation fails at any step."""

    def __init__(self, message: str, step: str, details: Optional[dict] = None):
        super().__init__(message)
        self.step = step
        self.details = details or {}

    def __str__(self) -> str:
        base = super().__str__()
        if self.details:
            return f"[{self.step}] {base} | details={self.details}"
        return f"[{self.step}] {base}"


class FlowProjectCreator:
    """Service tạo project trên Google Flow."""

    STEP_VALIDATE_CLIENT = "validate_client"
    STEP_DETECT_TIER = "detect_tier"
    STEP_CREATE_PROJECT = "create_project"
    STEP_SAVE_PROJECT = "save_project"
    STEP_CREATE_CHARACTERS = "create_characters"

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
        characters: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
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
            dict: Project info chi tiết với status, timestamps và metadata
        """
        created_at = datetime.now(timezone.utc).isoformat()
        project_data: Dict[str, Any] = {
            "name": name,
            "description": description or "",
            "story": story or "",
            "material": material,
            "tool_name": tool_name,
            "status": "pending",
            "step": self.STEP_VALIDATE_CLIENT,
            "created_at": created_at,
            "updated_at": created_at,
            "characters": characters or [],
            "flow_response": None,
            "user_paygate_tier": None,
            "project_id": None,
        }

        # Step 1: Validate client connection
        if not self.client.connected:
            project_data.update({
                "status": "error",
                "step": self.STEP_VALIDATE_CLIENT,
                "error": "Flow client not connected",
            })
            logger.error("Cannot create project: Flow client not connected")
            raise FlowProjectCreationError(
                "Flow client not connected",
                step=self.STEP_VALIDATE_CLIENT,
                details={"client_connected": self.client.connected},
            )

        project_data["step"] = self.STEP_DETECT_TIER

        # Step 2: Detect user tier
        try:
            tier = await self._detect_tier()
            project_data["user_paygate_tier"] = tier
        except Exception as e:
            project_data.update({
                "status": "error",
                "step": self.STEP_DETECT_TIER,
                "error": f"Tier detection failed: {e}",
            })
            logger.error("Tier detection failed during project creation: %s", e)
            raise FlowProjectCreationError(
                "Tier detection failed",
                step=self.STEP_DETECT_TIER,
                details={"error": str(e)},
            ) from e

        project_data["step"] = self.STEP_CREATE_PROJECT

        # Step 3: Create project on Google Flow
        logger.info("Creating project on Flow: %s", name)
        try:
            flow_result = await self.client.create_project(name, tool_name)
            project_data["flow_response"] = flow_result
        except Exception as e:
            project_data.update({
                "status": "error",
                "step": self.STEP_CREATE_PROJECT,
                "error": f"Flow API error: {e}",
            })
            logger.error("Flow API project creation failed: %s", e)
            raise FlowProjectCreationError(
                "Flow API project creation failed",
                step=self.STEP_CREATE_PROJECT,
                details={"error": str(e), "flow_result": flow_result if 'flow_result' in locals() else None},
            ) from e

        if flow_result.get("error"):
            project_data.update({
                "status": "error",
                "step": self.STEP_CREATE_PROJECT,
                "error": flow_result["error"],
            })
            logger.error("Flow API returned error: %s", flow_result["error"])
            raise FlowProjectCreationError(
                "Flow API returned error",
                step=self.STEP_CREATE_PROJECT,
                details={"flow_error": flow_result["error"], "flow_result": flow_result},
            )

        # Parse projectId từ response
        try:
            data = flow_result.get("data", {})
            result = data["result"]["data"]["json"]["result"]
            project_id = result["projectId"]
        except (KeyError, TypeError) as e:
            project_data.update({
                "status": "error",
                "step": self.STEP_CREATE_PROJECT,
                "error": f"Failed to parse Flow response: {e}",
                "flow_response": flow_result,
            })
            logger.error("Failed to parse Flow response: %s", e)
            raise FlowProjectCreationError(
                "Failed to parse Flow response",
                step=self.STEP_CREATE_PROJECT,
                details={"error": str(e), "flow_result": flow_result},
            ) from e

        project_data["project_id"] = project_id
        project_data["step"] = self.STEP_SAVE_PROJECT
        project_data["updated_at"] = datetime.now(timezone.utc).isoformat()

        logger.info("Flow project created: %s", project_id)

        # Step 4: Save to local database (nếu có db_adapter)
        db_project_data = {
            "id": project_id,
            "name": name,
            "description": description,
            "story": story,
            "material": material,
            "tool_name": tool_name,
            "user_paygate_tier": tier,
            "created_at": created_at,
            "updated_at": project_data["updated_at"],
            "metadata": {
                "flow_response": flow_result,
                "characters": characters or [],
            },
        }

        if self.db and hasattr(self.db, 'save_project'):
            try:
                await self.db.save_project(db_project_data)
                logger.info("Project saved to database: %s", project_id)
            except Exception as e:
                project_data.update({
                    "status": "error",
                    "step": self.STEP_SAVE_PROJECT,
                    "error": f"Database save failed: {e}",
                    "project_id": project_id,
                })
                logger.error("Failed to save project to database: %s", e)
                raise FlowProjectCreationError(
                    "Database save failed",
                    step=self.STEP_SAVE_PROJECT,
                    details={"error": str(e), "project_id": project_id},
                ) from e

        project_data["status"] = "success"
        project_data["step"] = "completed"
        project_data["updated_at"] = datetime.now(timezone.utc).isoformat()

        # Step 5: Create characters (nếu có)
        if characters and self.db:
            project_data["step"] = self.STEP_CREATE_CHARACTERS
            created_characters = []

            for char in characters:
                char_data = {
                    "name": char["name"],
                    "description": char.get("description", ""),
                    "entity_type": char.get("entity_type", "character"),
                    "voice_description": char.get("voice_description"),
                    "project_id": project_id,
                }

                if hasattr(self.db, 'save_character'):
                    try:
                        char_id = await self.db.save_character(char_data)

                        if hasattr(self.db, 'link_character'):
                            await self.db.link_character(project_id, char_id)
                            logger.info("Character '%s' linked to project", char['name'])

                        created_characters.append({
                            "id": char_id,
                            "name": char["name"],
                            "entity_type": char_data["entity_type"],
                        })
                    except Exception as e:
                        logger.error("Failed to create character '%s': %s", char['name'], e)
                        created_characters.append({
                            "name": char["name"],
                            "error": str(e),
                        })

            project_data["characters"] = created_characters
            project_data["updated_at"] = datetime.now(timezone.utc).isoformat()

        # Return clean summary for the caller
        return {
            "status": project_data["status"],
            "project_id": project_data["project_id"],
            "name": project_data["name"],
            "description": project_data["description"],
            "tool_name": project_data["tool_name"],
            "user_paygate_tier": project_data["user_paygate_tier"],
            "created_at": project_data["created_at"],
            "updated_at": project_data["updated_at"],
            "characters": project_data["characters"],
            "flow_response": project_data["flow_response"],
        }

    async def _detect_tier(self) -> str:
        """Auto-detect user paygate tier."""
        try:
            result = await self.client.get_credits()
            data = result.get("data", result)
            tier = data.get("userPaygateTier", "PAYGATE_TIER_ONE")
            logger.info("Detected tier: %s", tier)
            return tier
        except Exception as e:
            logger.warning("Failed to detect tier: %s, using TIER_ONE", e)
            return "PAYGATE_TIER_ONE"

    def get_project_summary(self, project_data: Dict[str, Any]) -> str:
        """
        Tạo summary text ngắn gọn cho project vừa tạo.

        Returns:
            str: Formatted summary string
        """
        status_icon = "✅" if project_data.get("status") == "success" else "❌"
        lines = [
            f"{status_icon} Project {project_data.get('status', 'unknown').upper()}",
            f"Name: {project_data.get('name', 'N/A')}",
            f"ID: {project_data.get('project_id', 'N/A')}",
        ]
        if project_data.get("description"):
            lines.append(f"Description: {project_data['description']}")
        if project_data.get("user_paygate_tier"):
            lines.append(f"Tier: {project_data['user_paygate_tier']}")
        if project_data.get("created_at"):
            lines.append(f"Created: {project_data['created_at']}")
        if project_data.get("characters"):
            char_names = [c.get("name", "?") for c in project_data["characters"] if isinstance(c, dict) and "name" in c]
            if char_names:
                lines.append(f"Characters: {', '.join(char_names)}")
        if project_data.get("error"):
            lines.append(f"Error: {project_data['error']}")
        return "\n".join(lines)
