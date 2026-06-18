"""
Example: Upload ảnh local lên Google Flow
"""
import asyncio
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from flow_client_wrapper import FlowClientWrapper
from flow_image_uploader import FlowImageUploader


async def main():
    # Step 1: Khởi tạo client
    client = FlowClientWrapper()
    
    # Note: Trong production, bạn cần:
    # - Set WebSocket connection từ Chrome Extension
    # - Set Flow API key
    # client.set_websocket(ws)
    # client.set_flow_key("your_flow_key")
    
    # Step 2: Khởi tạo image uploader
    uploader = FlowImageUploader(client)
    
    # Step 3: Upload ảnh
    try:
        result = await uploader.upload_image(
            file_path="./my_image.jpg",
            project_id="your_project_id",  # Optional
            file_name="custom_name.jpg",   # Optional
        )
        
        print(f"✅ Image uploaded successfully!")
        print(f"Media ID: {result['media_id']}")
        print(f"URL: {result['url']}")
        print(f"File name: {result['file_name']}")
        
    except Exception as e:
        print(f"❌ Error: {e}")


if __name__ == "__main__":
    asyncio.run(main())
