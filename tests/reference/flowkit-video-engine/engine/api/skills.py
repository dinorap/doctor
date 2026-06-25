import logging
import os
from pathlib import Path
from typing import List

from pydantic import BaseModel
from fastapi import APIRouter, HTTPException

from engine.config import BASE_DIR

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/library-skills", tags=["library-skills"])

SKILLS_DIR = BASE_DIR / "skills"


class Skill(BaseModel):
    id: str
    name: str
    content: str
    description: str = ""
    group: str = ""

def _parse_skill_metadata(content: str, filename: str) -> tuple[str, str]:
    description = ""
    lines = content.split('\n')
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if line.startswith('#'):
            if '—' in line:
                description = line.split('—', 1)[1].strip()
                break
            elif '-' in line:
                # avoid matching things like "# fk-command"
                parts = line.split('-', 1)
                if len(parts[1].strip()) > 5:
                    description = parts[1].strip()
                    break
        elif not line.startswith('>') and not line.startswith('['):
            if len(line) > 10:
                description = line[:120] + '...' if len(line) > 120 else line
                break
    
    if not description:
        description = "No description provided."
        
    # Grouping logic based on skill name (functional groups)
    name = filename.lower()
    if any(k in name for k in ['create-project', 'switch-project', 'dashboard']):
        group = 'Project Management'
    elif any(k in name for k in ['gen-refs', 'gen-images', 'gen-videos', 'chain-videos', 'insert-scene', 'concat', 'pipeline']):
        group = 'Generation Core'
    elif any(k in name for k in ['music', 'narrator', 'tts', 'import-voice']):
        group = 'Audio & Narration'
    elif any(k in name for k in ['review', 'text-overlays', 'brand-logo']):
        group = 'Enhancement & Review'
    elif any(k in name for k in ['youtube', 'thumbnail']):
        group = 'Publishing & YouTube'
    elif any(k in name for k in ['doctor', 'status', 'monitor', 'fix', 'refresh', 'upload', 'change']):
        group = 'Maintenance & Debug'
    elif any(k in name for k in ['material', 'camera', 'creative', 'research']):
        group = 'Style & Knowledge'
    else:
        group = 'Other'
        
    return description, group


class SkillCreateRequest(BaseModel):
    id: str
    content: str


class SkillUpdateRequest(BaseModel):
    content: str


@router.get("", response_model=List[Skill])
async def list_skills():
    """List all agent skills."""
    skills = []
    if not SKILLS_DIR.exists():
        return skills
    
    for file_path in SKILLS_DIR.glob("*.md"):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                content = f.read()
            description, group = _parse_skill_metadata(content, file_path.stem)
            skills.append(Skill(
                id=file_path.stem,
                name=file_path.name,
                content=content,
                description=description,
                group=group
            ))
        except Exception as e:
            logger.error(f"Error reading skill {file_path}: {e}")
            
    return sorted(skills, key=lambda s: s.id)


@router.get("/{skill_id}", response_model=Skill)
async def get_skill(skill_id: str):
    """Get an agent skill by ID."""
    file_path = SKILLS_DIR / f"{skill_id}.md"
    if not file_path.exists():
        raise HTTPException(404, f"Skill '{skill_id}' not found")
        
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
        description, group = _parse_skill_metadata(content, skill_id)
        return Skill(
            id=skill_id,
            name=f"{skill_id}.md",
            content=content,
            description=description,
            group=group
        )
    except Exception as e:
        logger.error(f"Error reading skill {skill_id}: {e}")
        raise HTTPException(500, "Error reading skill")


@router.post("", response_model=Skill, status_code=201)
async def create_skill(body: SkillCreateRequest):
    """Create a new agent skill."""
    if not body.id.strip():
        raise HTTPException(400, "Skill ID cannot be empty")
        
    file_path = SKILLS_DIR / f"{body.id}.md"
    if file_path.exists():
        raise HTTPException(409, f"Skill '{body.id}' already exists")
        
    try:
        SKILLS_DIR.mkdir(parents=True, exist_ok=True)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(body.content)
            
        logger.info(f"Skill created: {body.id}")
        description, group = _parse_skill_metadata(body.content, body.id)
        return Skill(
            id=body.id,
            name=f"{body.id}.md",
            content=body.content,
            description=description,
            group=group
        )
    except Exception as e:
        logger.error(f"Error creating skill {body.id}: {e}")
        raise HTTPException(500, "Error creating skill")


@router.patch("/{skill_id}", response_model=Skill)
async def update_skill(skill_id: str, body: SkillUpdateRequest):
    """Update an existing agent skill."""
    file_path = SKILLS_DIR / f"{skill_id}.md"
    if not file_path.exists():
        raise HTTPException(404, f"Skill '{skill_id}' not found")
        
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(body.content)
            
        logger.info(f"Skill updated: {skill_id}")
        description, group = _parse_skill_metadata(body.content, skill_id)
        return Skill(
            id=skill_id,
            name=f"{skill_id}.md",
            content=body.content,
            description=description,
            group=group
        )
    except Exception as e:
        logger.error(f"Error updating skill {skill_id}: {e}")
        raise HTTPException(500, "Error updating skill")


@router.delete("/{skill_id}")
async def delete_skill(skill_id: str):
    """Delete an agent skill."""
    file_path = SKILLS_DIR / f"{skill_id}.md"
    if not file_path.exists():
        raise HTTPException(404, f"Skill '{skill_id}' not found")
        
    try:
        os.remove(file_path)
        logger.info(f"Skill deleted: {skill_id}")
        return {"ok": True}
    except Exception as e:
        logger.error(f"Error deleting skill {skill_id}: {e}")
        raise HTTPException(500, "Error deleting skill")
