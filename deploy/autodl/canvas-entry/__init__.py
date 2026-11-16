"""Serve the separately running canvas through the existing AutoDL HTTPS entrance."""
import asyncio
from aiohttp import ClientError, ClientSession, ClientTimeout, WSServerHandshakeError, WSMsgType, web
from multidict import CIMultiDict
from yarl import URL
from server import PromptServer

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
UPSTREAM = "http://127.0.0.1:6008"
HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"}
routes = PromptServer.instance.routes


def proxy_headers(source):
    blocked = HOP_HEADERS | {value.strip().lower() for value in source.get("Connection", "").split(",")}
    return CIMultiDict((key, value) for key, value in source.items() if key.lower() not in blocked)


@routes.get("/canvas")
async def canvas_redirect(request):
    raise web.HTTPFound("/canvas/")


@routes.route("*", "/canvas/{path:.*}")
async def canvas_entry(request):
    url = URL(UPSTREAM + request.raw_path, encoded=True)
    headers = proxy_headers(request.headers)
    # Preserve the public authority so Node can enforce its exact origin policy.
    # The destination remains the fixed localhost UPSTREAM, independent of Host.
    if "Host" not in headers:
        headers["Host"] = "127.0.0.1:6008"
    response = downstream = None
    try:
        if request.headers.get("Upgrade", "").lower() == "websocket":
            protocols = [value.strip() for value in request.headers.get("Sec-WebSocket-Protocol", "").split(",") if value.strip()]
            ws_headers = CIMultiDict((key, value) for key, value in headers.items() if not key.lower().startswith("sec-websocket-"))
            async with ClientSession(timeout=ClientTimeout(total=None, sock_connect=10)) as session:
                async with session.ws_connect(url, headers=ws_headers, protocols=protocols, autoclose=True, autoping=True) as upstream:
                    downstream = web.WebSocketResponse(protocols=[upstream.protocol] if upstream.protocol else (), autoping=True)
                    await downstream.prepare(request)

                    async def pump(source, target):
                        async for message in source:
                            if message.type == WSMsgType.TEXT:
                                await target.send_str(message.data)
                            elif message.type == WSMsgType.BINARY:
                                await target.send_bytes(message.data)
                            elif message.type in (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR):
                                break
                        await target.close()

                    tasks = [asyncio.create_task(pump(downstream, upstream)), asyncio.create_task(pump(upstream, downstream))]
                    try:
                        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    finally:
                        for task in tasks:
                            if not task.done(): task.cancel()
                        await asyncio.gather(*tasks, return_exceptions=True)
                    return downstream

        async with ClientSession(timeout=ClientTimeout(total=None, sock_connect=10), auto_decompress=False) as session:
            async with session.request(request.method, url, headers=headers, data=request.content, allow_redirects=False) as upstream:
                response_headers = proxy_headers(upstream.headers)
                response = web.StreamResponse(status=upstream.status, headers=response_headers)
                await response.prepare(request)
                async for chunk in upstream.content.iter_chunked(65536):
                    await response.write(chunk)
                await response.write_eof()
                return response
    except WSServerHandshakeError as failure:
        return web.json_response({"error": "Canvas WebSocket handshake was rejected"}, status=failure.status if 400 <= failure.status <= 599 else 502)
    except (ClientError, OSError, asyncio.TimeoutError):
        if downstream is not None and downstream.prepared:
            await downstream.close(code=1011, message=b"Canvas upstream disconnected")
            return downstream
        if response is not None and response.prepared:
            if request.transport is not None:
                request.transport.close()
            return response
        return web.json_response({"error": "Canvas service on port 6008 is unavailable"}, status=503)
