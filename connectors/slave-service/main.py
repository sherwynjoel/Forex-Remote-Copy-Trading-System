"""
Slave connector for the Forex Remote Copy Trading System.

Holds a persistent WebSocket to the backend (true push, zero polling for
delivery) and calls MetaTrader5.order_send() directly against a locally
running, logged-in MT5 terminal. Contains no risk/volume logic — the
backend's Copy Engine decides *what* to send; this only executes it and
reports back what actually happened, per the system's layering rule.

Message shapes (mirrors backend/src/types/copyOrder.ts exactly):

  instruction (backend -> here):
    {"copyId": "...", "action": "OPEN"|"CLOSE"|"MODIFY", "symbol": "XAUUSD",
     "side": "BUY"|"SELL", "volume": 1.0, "sl": 3340.20, "tp": 3370.20,
     "slaveTicket": "875421"}   # slaveTicket present only for CLOSE/MODIFY

  result (here -> backend):
    {"copyId": "...", "status": "EXECUTED"|"FAILED",
     "slaveTicket": "875421", "executionPrice": 3350.40, "reason": "..."}
"""

import asyncio
import json
import logging
import os
import signal

import MetaTrader5 as mt5
import websockets
from websockets.exceptions import ConnectionClosed

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("forex-copy-slave")

BACKEND_WS_URL = os.environ.get("BACKEND_WS_URL", "ws://localhost:4000/ws/slave")
CONNECTOR_TOKEN = os.environ.get("CONNECTOR_TOKEN", "")
HEARTBEAT_INTERVAL_SECONDS = float(os.environ.get("HEARTBEAT_INTERVAL_SECONDS", "5"))
RECONNECT_DELAY_SECONDS = float(os.environ.get("RECONNECT_DELAY_SECONDS", "3"))

ORDER_SIDE_TO_TYPE = {"BUY": mt5.ORDER_TYPE_BUY, "SELL": mt5.ORDER_TYPE_SELL}


def ensure_mt5_ready() -> None:
    if not mt5.initialize():
        raise RuntimeError(f"MetaTrader5.initialize() failed: {mt5.last_error()}")
    log.info("Connected to MT5 terminal, account=%s", mt5.account_info())


def execute_open(instruction: dict) -> dict:
    symbol = instruction["symbol"]
    if not mt5.symbol_select(symbol, True):
        return _failure(instruction, f"symbol not available: {symbol}")

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return _failure(instruction, f"no tick data for symbol: {symbol}")

    side = instruction["side"]
    order_type = ORDER_SIDE_TO_TYPE[side]
    price = tick.ask if side == "BUY" else tick.bid

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": float(instruction["volume"]),
        "type": order_type,
        "price": price,
        "sl": float(instruction.get("sl") or 0),
        "tp": float(instruction.get("tp") or 0),
        "deviation": 20,
        "type_filling": mt5.ORDER_FILLING_IOC,
        "type_time": mt5.ORDER_TIME_GTC,
        "comment": f"copy:{instruction['copyId']}",
    }
    result = mt5.order_send(request)

    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        reason = getattr(result, "comment", None) or str(mt5.last_error())
        return _failure(instruction, f"order_send failed: {reason}")

    return {
        "copyId": instruction["copyId"],
        "status": "EXECUTED",
        "slaveTicket": str(result.order),
        "executionPrice": result.price,
    }


def execute_close(instruction: dict) -> dict:
    ticket = int(instruction["slaveTicket"])
    positions = mt5.positions_get(ticket=ticket)
    if not positions:
        return _failure(instruction, f"no open position for ticket {ticket}")

    position = positions[0]
    symbol = position.symbol
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return _failure(instruction, f"no tick data for symbol: {symbol}")

    closing_type = mt5.ORDER_TYPE_SELL if position.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
    price = tick.bid if closing_type == mt5.ORDER_TYPE_SELL else tick.ask

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": position.volume,
        "type": closing_type,
        "position": ticket,
        "price": price,
        "deviation": 20,
        "type_filling": mt5.ORDER_FILLING_IOC,
        "type_time": mt5.ORDER_TIME_GTC,
        "comment": f"copy:{instruction['copyId']}",
    }
    result = mt5.order_send(request)

    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        reason = getattr(result, "comment", None) or str(mt5.last_error())
        return _failure(instruction, f"close failed: {reason}")

    return {
        "copyId": instruction["copyId"],
        "status": "EXECUTED",
        "slaveTicket": str(ticket),
        "executionPrice": result.price,
    }


def execute_modify(instruction: dict) -> dict:
    ticket = int(instruction["slaveTicket"])
    request = {
        "action": mt5.TRADE_ACTION_SLTP,
        "position": ticket,
        "sl": float(instruction.get("sl") or 0),
        "tp": float(instruction.get("tp") or 0),
    }
    result = mt5.order_send(request)

    if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
        reason = getattr(result, "comment", None) or str(mt5.last_error())
        return _failure(instruction, f"modify failed: {reason}")

    return {"copyId": instruction["copyId"], "status": "EXECUTED", "slaveTicket": str(ticket)}


def _failure(instruction: dict, reason: str) -> dict:
    log.warning("copy %s failed: %s", instruction.get("copyId"), reason)
    return {"copyId": instruction["copyId"], "status": "FAILED", "reason": reason}


EXECUTORS = {"OPEN": execute_open, "CLOSE": execute_close, "MODIFY": execute_modify}


async def handle_instruction(instruction: dict) -> dict:
    executor = EXECUTORS.get(instruction.get("action"))
    if executor is None:
        return _failure(instruction, f"unsupported action: {instruction.get('action')}")
    # MetaTrader5 calls are blocking; run off the event loop so a slow
    # broker response doesn't stall heartbeats or other instructions.
    return await asyncio.to_thread(executor, instruction)


async def heartbeat_loop(ws) -> None:
    while True:
        await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)
        await ws.send(json.dumps({"type": "heartbeat"}))


async def run_once() -> None:
    headers = {"Authorization": f"Bearer {CONNECTOR_TOKEN}"}
    async with websockets.connect(BACKEND_WS_URL, additional_headers=headers) as ws:
        log.info("connected to %s", BACKEND_WS_URL)
        heartbeat_task = asyncio.create_task(heartbeat_loop(ws))
        try:
            async for raw in ws:
                instruction = json.loads(raw)
                log.info("received instruction: %s", instruction)
                result = await handle_instruction(instruction)
                await ws.send(json.dumps(result))
                log.info("sent result: %s", result)
        finally:
            heartbeat_task.cancel()


async def main() -> None:
    if not CONNECTOR_TOKEN:
        raise SystemExit("CONNECTOR_TOKEN env var is required (from POST /api/slaves/:id/connectors)")

    ensure_mt5_ready()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass  # signal handlers aren't available on Windows for all signals

    while not stop.is_set():
        try:
            await run_once()
        except ConnectionClosed as exc:
            log.warning("disconnected (%s), reconnecting in %ss", exc, RECONNECT_DELAY_SECONDS)
        except Exception:
            log.exception("connection error, reconnecting in %ss", RECONNECT_DELAY_SECONDS)

        if stop.is_set():
            break
        await asyncio.sleep(RECONNECT_DELAY_SECONDS)

    mt5.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
