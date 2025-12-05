import asyncio
import websockets
import json

async def test():
    uri = "ws://localhost:8000/ws/ask"
    async with websockets.connect(uri) as ws:
        await ws.send(json.dumps({"question": "Tell me about yourself"}))

        async for msg in ws:
            print(">", msg)
            if msg == "[END]":
                break

asyncio.run(test())
