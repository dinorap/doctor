"""
Example: Generate video từ ảnh qua Google Flow API
"""
import asyncio
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from flow_client_wrapper import FlowClientWrapper
from flow_video_generator import FlowVideoGenerator


async def main():
    # Step 1: Khởi tạo client
    client = FlowClientWrapper()
    
    # Note: Trong production, bạn cần:
    # - Set WebSocket connection từ Chrome Extension
    # - Set Flow API key
    # client.set_websocket(ws)
    # client.set_flow_key("your_flow_key")
    
    # Step 2: Khởi tạo video generator
    generator = FlowVideoGenerator(client)
    
    # Step 3: Generate video
    try:
        # Option A: Submit và đợi complete luôn
        result = await generator.generate_video(
            start_image_media_id="your_start_image_media_id",
            prompt="Camera zooms in slowly",
            project_id="your_project_id",
            scene_id="your_scene_id",
            aspect_ratio="PORTRAIT",
            wait_for_completion=True,  # Đợi video generate xong
            poll_interval=10,          # Check status mỗi 10s
        )
        
        print(f"✅ Video generated successfully!")
        print(f"Status: {result['status']}")
        print(f"Media ID: {result.get('media_id')}")
        print(f"URL: {result.get('url')}")
        
    except Exception as e:
        print(f"❌ Error: {e}")
    
    # Option B: Submit rồi check status sau
    try:
        # Submit
        result = await generator.generate_video(
            start_image_media_id="your_start_image_media_id",
            prompt="Camera pans to the right",
            project_id="your_project_id",
            scene_id="your_scene_id",
            wait_for_completion=False,  # Không đợi
        )
        
        operations = result['operations']
        print(f"📤 Video generation submitted!")
        
        # Check status sau đó
        await asyncio.sleep(30)  # Đợi 30s
        
        status = await generator.check_status(operations)
        print(f"Status: {status['status']}")
        
        if status['status'] == 'DONE':
            print(f"✅ Video ready!")
            print(f"Media ID: {status['media_id']}")
            print(f"URL: {status['url']}")
        else:
            print(f"⏳ Still processing: {status.get('progress')}")
        
    except Exception as e:
        print(f"❌ Error: {e}")


if __name__ == "__main__":
    asyncio.run(main())
