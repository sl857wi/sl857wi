import struct
import time
from dataclasses import dataclass
from typing import Optional

import serial

DEFAULT_ADDR = bytes([0xFF, 0xFF, 0xFF, 0xFF])
DEFAULT_BAUD = 57600
DEFAULT_CAPACITY = 300


class AS608Error(RuntimeError):
    """Všeobecná chyba pri komunikácii so senzorom AS608."""


@dataclass
class SearchResult:
    # Výsledok hľadania alebo porovnania nesie ID šablóny a skóre zhody.
    template_id: int
    score: int


def _checksum(pkt_wo_header: bytes) -> int:
    return sum(pkt_wo_header) & 0xFFFF


def make_packet(payload: bytes, pid: int = 0x01, addr: bytes = DEFAULT_ADDR) -> bytes:
    """
    Vytvorí dátový paket podľa protokolu senzora:
    0xEF01 + addr(4) + pid(1) + length(2) + payload + checksum(2)
    """
    length = len(payload) + 2
    pkt_wo = bytes([pid, (length >> 8) & 0xFF, length & 0xFF]) + payload
    chksum = _checksum(pkt_wo)
    return b"\xEF\x01" + addr + pkt_wo + struct.pack(">H", chksum)


def parse_response(resp: bytes) -> tuple[int, bytes]:
    """
    Zo surovej odpovede senzora vytiahne potvrdzovací kód a payload.
    """
    if len(resp) < 12:
        raise AS608Error(f"short_response: {len(resp)} bytes")

    if resp[0:2] != b"\xEF\x01":
        raise AS608Error("bad_header")

    pid = resp[6]
    length = (resp[7] << 8) | resp[8]
    total = 9 + length
    if len(resp) < total:
        raise AS608Error("truncated_response")

    payload = resp[9 : 9 + (length - 2)]
    if not payload:
        raise AS608Error("empty_payload")

    # Checksum znovu neoverujeme, lebo modul pri chybnom pakete vráti vlastnú chybu.
    _ = pid
    confirm = payload[0]
    return confirm, payload


class AS608:
    def __init__(self, port: str, baud: int = DEFAULT_BAUD, timeout: float = 0.6):
        # Pri vytvorení objektu otvoríme sériovú komunikáciu so senzorom.
        self.addr = DEFAULT_ADDR
        self.capacity = DEFAULT_CAPACITY
        self.ser = serial.Serial(port, baudrate=baud, timeout=timeout)
        time.sleep(0.05)

    def close(self):
        # Zatvorenie portu robíme opatrne, aby aplikácia nespadla pri uzavretí chybného zariadenia.
        try:
            self.ser.close()
        except Exception:
            pass

    def _send_cmd(self, payload: bytes, resp_read: int = 64, delay: float = 0.12) -> bytes:
        # Každý príkaz zabalíme do paketu, zapíšeme do portu a po krátkej pauze prečítame odpoveď.
        self.ser.reset_input_buffer()
        self.ser.write(make_packet(payload, pid=0x01, addr=self.addr))
        time.sleep(delay)
        return self.ser.read(resp_read)

    def _require_ok(self, confirm: int, op: str):
        if confirm != 0x00:
            raise AS608Error(f"{op}_failed: code=0x{confirm:02X}")

    def load_char(self, template_id: int, buffer_id: int = 2) -> None:
        # LoadChar načíta šablónu z internej pamäte senzora do zvoleného bufferu.
        payload = bytes([0x07, buffer_id]) + struct.pack(">H", int(template_id))
        resp = self._send_cmd(payload, resp_read=32, delay=0.25)
        confirm, _ = parse_response(resp)
        self._require_ok(confirm, "loadchar")

    def match(self) -> int:
        # Match porovná obsah bufferov a vráti skóre zhody.
        resp = self._send_cmd(bytes([0x03]), resp_read=32, delay=0.25)
        confirm, pl = parse_response(resp)
        self._require_ok(confirm, "match")
        if len(pl) < 3:
            raise AS608Error("match_response_short")
        score = struct.unpack(">H", pl[1:3])[0]
        return score

    # -------- Nízkoúrovňové operácie --------
    def wait_finger_and_get_image(self, timeout_s: float = 6.0) -> None:
        """
        Opakovane skúša príkaz GetImage, kým senzor úspešne nezachytí prst
        alebo nevyprší časový limit.
        """
        t0 = time.time()
        while time.time() - t0 < timeout_s:
            resp = self._send_cmd(bytes([0x01]), resp_read=32, delay=0.12)
            try:
                confirm, _ = parse_response(resp)
            except AS608Error:
                time.sleep(0.05)
                continue

            if confirm == 0x00:
                return

            time.sleep(0.05)

        raise AS608Error("get_image_timeout")

    def image2tz(self, buffer_id: int = 1) -> None:
        """
        Image2Tz prevedie načítaný obraz prsta na charakteristiku uloženú do bufferu 1 alebo 2.
        """
        if buffer_id not in (1, 2):
            raise ValueError("buffer_id must be 1 or 2")

        resp = self._send_cmd(bytes([0x02, buffer_id]), resp_read=32, delay=0.20)
        confirm, _ = parse_response(resp)
        self._require_ok(confirm, "image2tz")

    def reg_model(self) -> None:
        """
        RegModel spojí dve charakteristiky do jednej výslednej šablóny.
        """
        resp = self._send_cmd(bytes([0x05]), resp_read=32, delay=0.20)
        confirm, _ = parse_response(resp)
        self._require_ok(confirm, "regmodel")

    def store(self, template_id: int, buffer_id: int = 1) -> None:
        """
        Store uloží šablónu z bufferu do trvalej pamäte senzora.
        """
        if not (0 <= template_id <= 0xFFFF):
            raise ValueError("template_id out of range")
        if buffer_id not in (1, 2):
            raise ValueError("buffer_id must be 1 or 2")

        payload = bytes([0x06, buffer_id]) + struct.pack(">H", int(template_id))
        resp = self._send_cmd(payload, resp_read=32, delay=0.25)
        confirm, _ = parse_response(resp)
        self._require_ok(confirm, "store")

    def search(
        self,
        start_page: int = 0,
        page_num: int = DEFAULT_CAPACITY,
        buffer_id: int = 1,
    ) -> Optional[SearchResult]:
        """
        Search prehľadá vnútornú databázu šablón a vráti najbližšiu zhodu.
        """
        if buffer_id not in (1, 2):
            raise ValueError("buffer_id must be 1 or 2")

        payload = bytes([0x04, buffer_id]) + struct.pack(">HH", int(start_page), int(page_num))
        resp = self._send_cmd(payload, resp_read=32, delay=0.25)
        confirm, pl = parse_response(resp)

        if confirm != 0x00:
            return None

        if len(pl) < 5:
            raise AS608Error("search_response_short")

        page_id = struct.unpack(">H", pl[1:3])[0]
        score = struct.unpack(">H", pl[3:5])[0]
        return SearchResult(template_id=page_id, score=score)

    # -------- Vysokoúrovňové operácie --------
    def enroll(self, template_id: int, capture_timeout_s: float = 8.0) -> None:
        """
        Registrácia šablóny prebieha dvomi snímkami prsta, ich spojením a uložením do pamäte.
        """
        self.wait_finger_and_get_image(timeout_s=capture_timeout_s)
        self.image2tz(buffer_id=1)

        # Krátka pauza dáva používateľovi priestor dať prst preč a znova ho priložiť.
        time.sleep(0.8)

        self.wait_finger_and_get_image(timeout_s=capture_timeout_s)
        self.image2tz(buffer_id=2)

        self.reg_model()
        self.store(template_id=template_id, buffer_id=1)

    def verify_matches(self, expected_template_id: int, capture_timeout_s: float = 5.0) -> SearchResult:
        """
        Overenie zhody porovná aktuálne priloženú vzorku s už uloženou šablónou konkrétneho používateľa.
        """
        self.wait_finger_and_get_image(timeout_s=capture_timeout_s)
        self.image2tz(buffer_id=1)

        self.load_char(template_id=int(expected_template_id), buffer_id=2)

        score = self.match()
        return SearchResult(template_id=int(expected_template_id), score=int(score))
