"""
Example: Generate ảnh qua Google Flow API
"""
import asyncio
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from flow_client_wrapper import FlowClientWrapper
from flow_image_generator import FlowImageGenerator


async def main():
    # Step 1: Khởi tạo client
    client = FlowClientWrapper()
    
    # Note: Trong production, bạn cần:
    # - Set WebSocket connection từ Chrome Extension
    # - Set Flow API key
    # client.set_websocket(ws)
    # client.set_flow_key("your_flow_key")
    
    # Step 2: Khởi tạo image generator
    generator = FlowImageGenerator(client)
    
    # Step 3: Generate ảnh
    try:
        result = await generator.generate_image(
            prompt="A beautiful sunset over mountains",
            project_id="your_project_id",
            aspect_ratio="LANDSCAPE",
            download_to="./generated_image.jpg",  # Optional: download về local
        )
        
        print(f"✅ Image generated successfully!")
        print(f"Media ID: {result['media_id']}")
        print(f"URL: {result['url']}")
        
        if result.get('local_path'):
            print(f"Downloaded to: {result['local_path']}")
        
    except Exception as e:
        print(f"❌ Error: {e}")


if __name__ == "__main__":
    asyncio.run(main())
