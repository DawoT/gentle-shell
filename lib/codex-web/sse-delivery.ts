/** Observe framing without buffering the response or changing the bytes delivered to Pi. */
export class SseDelivery {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly maxEventBytes = 8 * 1024 * 1024;
  private parts: string[] = [];
  private lineBytes = 0;
  private data: string[] = [];
  private eventBytes = 0;
  private afterCr = false;
  private responseId?: string;
  private terminal = false;

  push(bytes: Uint8Array): void {
    this.text(this.decoder.decode(bytes, { stream: true }));
  }

  finish(): void {
    this.text(this.decoder.decode());
    // SSE dispatch requires a blank line. An unfinished frame is never proof of delivery.
    if (!this.terminal || this.parts.length || this.data.length) {
      throw new Error("Bridge stream ended without a complete terminal event; delivery is uncertain");
    }
  }

  private append(part: string): void {
    if (!part) return;
    this.lineBytes += Buffer.byteLength(part);
    if (this.eventBytes + this.lineBytes > this.maxEventBytes) {
      throw new Error("Bridge SSE event exceeds its size budget; delivery is uncertain");
    }
    this.parts.push(part);
  }

  private text(text: string): void {
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (this.afterCr) {
        this.afterCr = false;
        if (code === 10) {
          start = index + 1;
          continue;
        }
      }
      if (code !== 10 && code !== 13) continue;
      this.append(text.slice(start, index));
      this.line(this.parts.join(""));
      this.parts = [];
      this.lineBytes = 0;
      this.afterCr = code === 13;
      start = index + 1;
    }
    this.append(text.slice(start));
  }

  private line(line: string): void {
    if (!line) {
      if (this.data.length) this.event(this.data.join("\n"));
      this.data = [];
      this.eventBytes = 0;
      return;
    }
    this.eventBytes += this.lineBytes + 1;
    if (this.eventBytes > this.maxEventBytes) {
      throw new Error("Bridge SSE event exceeds its size budget; delivery is uncertain");
    }
    if (line === "data") {
      this.data.push("");
    } else if (line.startsWith("data:")) {
      const value = line.slice(5);
      this.data.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }

  private event(data: string): void {
    if (data === "[DONE]") return;
    let event: Record<string, any>;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error("Invalid bridge SSE event; delivery is uncertain");
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error("Invalid bridge SSE event; delivery is uncertain");
    }
    if (event.type === "response.created") {
      if (this.responseId || typeof event.response?.id !== "string" || !event.response.id) {
        throw new Error("Invalid bridge response identity; delivery is uncertain");
      }
      this.responseId = event.response.id;
    } else if (["response.completed", "response.failed", "response.incomplete"].includes(event.type)) {
      if (!this.responseId || event.response?.id !== this.responseId || this.terminal) {
        throw new Error("Invalid bridge terminal identity; delivery is uncertain");
      }
      if (event.type === "response.completed" && (event.response.status !== "completed" || !Array.isArray(event.response.output))) {
        throw new Error("Invalid bridge completion; delivery is uncertain");
      }
      this.terminal = true;
    } else if (event.type === "error") {
      this.terminal = true;
    }
  }
}
