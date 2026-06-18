"""
Example: Full workflow - Tạo project → Upload ảnh → Generate video
"""
import asyncio
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from flow_client_wrapper import FlowClientWrapper
from flow_project_creator import FlowProjectCreator
from flow_image_uploader import FlowImageUploader
from flow_video_generator import FlowVideoGenerator


async def main():
    # Step 1: Khởi tạo client
    client = FlowClientWrapper()
    
    # Note: Trong production, bạn cần:
    # - Set WebSocket connection từ Chrome Extension
    # - Set Flow API key
    # client.set_websocket(ws)
    # client.set_flow_key("your_flow_key")
    
    print("🚀 Starting full workflow...")
    
    try:
        # Step 2: Tạo project
        print("\n📁 Creating project...")
        creator = FlowProjectCreator(client)
        project = await creator.create_project(
            name="My Video Project",
            description="Testing full workflow",
            material="realistic",
        )
        project_id = project['id']
        print(f"✅ Project created: {project_id}")
        
        # Step 3: Upload ảnh
        print("\n🖼️  Uploading image...")
        uploader = FlowImageUploader(client)
        upload_result = await uploader.upload_image(
            file_path="./start_image.jpg",
            project_id=project_id,
        )
        start_image_id = upload_result['media_id']
        print(f"✅ Image uploaded: {start_image_id}")
        
        # Step 4: Generate video
        print("\n🎬 Generating video...")
        video_gen = FlowVideoGenerator(client)
        video_result = await video_gen.generate_video(
            start_image_media_id=start_image_id,
            prompt="Camera slowly zooms in",
            project_id=project_id,
            scene_id="scene_1",
            aspect_ratio="PORTRAIT",
            wait_for_completion=True,
            poll_interval=15,
        )
        
        print(f"\n✅ Video generation complete!")
        print(f"Media ID: {video_result['media_id']}")
        print(f"URL: {video_result['url']}")
        
        print("\n🎉 Workflow completed successfully!")
        
    except Exception as e:
        print(f"\n❌ Workflow failed: {e}")


if __name__ == "__main__":
    asyncio.run(main())
