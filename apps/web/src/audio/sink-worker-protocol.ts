// Message contract between the desk main thread and the sink worker.

export interface DeskStreamStatus {
  takeId: string;
  streamId: string;
  chwm: number | null;
  heldCount: number;
  holes: Array<[number, number]>;
  gaps: Array<[number, number]>;
  finalSeq: number | null;
  complete: boolean;
  settled: boolean;
  flagged: boolean;
  /** sha256 over (seq, crc32c) LE pairs in seq order — must equal the
   * server's digest for the same stream when converged. */
  digest: string;
}

export type ToSinkWorker =
  | { type: "configure"; sessionId: string }
  | { type: "frame"; connId: number; bytes: ArrayBuffer }
  | { type: "set-final"; takeId: string; streamId: string; finalSeq: number }
  | { type: "acks" }
  | { type: "haves" }
  | { type: "plan-push"; haveBytes: ArrayBuffer }
  | { type: "get-frames"; takeId: string; streamId: string; ranges: Array<[number, number]> }
  | { type: "status" };

export type FromSinkWorker =
  | { type: "ready"; rebuiltChunks: number }
  | { type: "reply"; connId: number; bytes: ArrayBuffer }
  | { type: "acks-result"; frames: ArrayBuffer[] }
  | { type: "haves-result"; frames: ArrayBuffer[] }
  | {
      type: "push-plan";
      takeId: string;
      streamId: string;
      ranges: Array<[number, number]>;
    }
  | { type: "frames-result"; frames: ArrayBuffer[] }
  | { type: "status-result"; streams: DeskStreamStatus[] }
  | { type: "error"; message: string };
