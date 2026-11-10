// External GNSS receiver over Web Serial: Bluetooth (RFCOMM/SPP) on Chrome for Android 138+,
// USB on desktop Chrome/Edge (and Android in newer Chrome). Reads the NMEA stream the receiver
// already outputs, so we get real per-satellite data (azimuth, elevation, C/N0) live, which the
// phone's own browser location API never exposes.
//
// Privacy: everything stays in this page. Nothing is sent anywhere.

import { useCallback, useEffect, useRef, useState } from 'react'
import { LogParser, type Epoch, type LogFix } from './logParser'

// Minimal Web Serial typings (not in TypeScript's DOM lib yet).
type SerialPortInfo = { usbVendorId?: number; usbProductId?: number; bluetoothServiceClassId?: number | string }
type SerialPortLike = {
  open(o: { baudRate: number }): Promise<void>
  close(): Promise<void>
  readable: ReadableStream<Uint8Array> | null
  getInfo?(): SerialPortInfo
}
type SerialLike = { requestPort(o?: { filters?: unknown[]; allowedBluetoothServiceClassIds?: string[] }): Promise<SerialPortLike> }

/** Bluetooth Serial Port Profile: what Bluetooth GNSS receivers expose. */
const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb'
const MAX_LINE = 4096

export type ReceiverState = 'unsupported' | 'idle' | 'connecting' | 'connected' | 'error'
export type ReceiverData = { epochs: Epoch[]; fixes: LogFix[]; lines: number; badLines: number }

export const serialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator

/** UTC time-of-day (ms) from an NMEA hhmmss.ss field. */
function nmeaTod(f: string) {
  if (!/^\d{6}(\.\d+)?$/.test(f)) return null
  return ((Number(f.slice(0, 2)) * 60 + Number(f.slice(2, 4))) * 60 + Number(f.slice(4))) * 1000
}

export function useSerialReceiver() {
  const [state, setState] = useState<ReceiverState>(serialSupported() ? 'idle' : 'unsupported')
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<ReceiverData>({ epochs: [], fixes: [], lines: 0, badLines: 0 })
  const [info, setInfo] = useState<string | null>(null)
  /** Receiver time minus phone time (ms), median of recent time sentences. Spoofing shifts it. */
  const [timeOffsetMs, setTimeOffsetMs] = useState<number | null>(null)
  const io = useRef<{ port: SerialPortLike | null; reader: ReadableStreamDefaultReader<string> | null; stop: boolean; timer: number | null }>({ port: null, reader: null, stop: false, timer: null })

  const disconnect = useCallback(async () => {
    const s = io.current
    s.stop = true
    if (s.timer !== null) { window.clearInterval(s.timer); s.timer = null }
    try { await s.reader?.cancel() } catch { /* already closed */ }
    try { await s.port?.close() } catch { /* already closed */ }
    s.reader = null; s.port = null
    setState((st) => (st === 'unsupported' ? st : 'idle'))
  }, [])

  const connect = useCallback(async (baudRate: number) => {
    if (!serialSupported()) return
    setError(null)
    let port: SerialPortLike
    try {
      // Must run directly in the tap handler: the browser shows its own device picker.
      port = await (navigator as Navigator & { serial: SerialLike }).serial.requestPort({ allowedBluetoothServiceClassIds: [SPP_UUID] })
    } catch (e) {
      // The user closed the picker without choosing: not an error worth shouting about.
      if (e instanceof DOMException && e.name === 'NotFoundError') return
      setError(e instanceof Error ? e.message : String(e)); setState('error'); return
    }
    setState('connecting')
    try {
      await port.open({ baudRate })
    } catch (e) {
      setError(`פתיחת החיבור נכשלה: ${e instanceof Error ? e.message : String(e)}`); setState('error'); return
    }
    const i = port.getInfo?.() ?? {}
    setInfo(i.bluetoothServiceClassId ? 'Bluetooth' : i.usbVendorId !== undefined ? `USB ${i.usbVendorId.toString(16).padStart(4, '0')}:${(i.usbProductId ?? 0).toString(16).padStart(4, '0')}` : 'סדרתי')
    const parser = new LogParser('external-receiver', { live: true })
    const offsets: number[] = []
    const s = io.current
    s.port = port; s.stop = false
    setState('connected')
    s.timer = window.setInterval(() => {
      setData(parser.snapshot())
      if (offsets.length) { const sorted = offsets.slice().sort((a, b) => a - b); setTimeOffsetMs(sorted[sorted.length >> 1]) }
    }, 1000)

    try {
      const reader = port.readable!.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).getReader()
      s.reader = reader
      let carry = ''
      while (!s.stop) {
        const { value, done } = await reader.read()
        if (done) break
        const parts = (carry + value).split(/\r?\n/)
        carry = parts.pop() ?? ''
        if (carry.length > MAX_LINE) { carry = ''; parser.skipLine() }
        for (const line of parts) {
          parser.push(line)
          // Receiver clock vs phone clock, from RMC/GGA time-of-day.
          const m = /^\$G[A-Z]{1,2}(RMC|GGA),([^,]*)/.exec(line)
          const tod = m ? nmeaTod(m[2]) : null
          if (tod !== null) {
            const now = Date.now(), phoneTod = now % 86400000
            let d = tod - phoneTod
            if (d > 43200000) d -= 86400000; else if (d < -43200000) d += 86400000
            offsets.push(d); if (offsets.length > 20) offsets.shift()
          }
        }
      }
    } catch (e) {
      if (!s.stop) { setError(`החיבור נקטע: ${e instanceof Error ? e.message : String(e)}`); setState('error') }
    } finally {
      if (s.timer !== null) { window.clearInterval(s.timer); s.timer = null }
      setData(parser.snapshot())
      if (!s.stop) { try { await port.close() } catch { /* ignore */ } s.port = null; setState((st) => (st === 'error' ? st : 'idle')) }
    }
  }, [])

  useEffect(() => () => { void disconnect() }, [disconnect])

  return { state, error, data, info, timeOffsetMs, connect, disconnect, supported: state !== 'unsupported' }
}
