"use strict";

class InferenceQueue {
  constructor(limit = 16) {
    this.limit = limit;
    this.pending = [];
    this.busy = false;
  }

  run(work, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason || new Error("Inference cancelled."));
    if (this.pending.length >= this.limit) return Promise.reject(new Error("The local inference queue is full. Try again after a run finishes."));
    return new Promise((resolve, reject) => {
      const job = { work, signal, resolve, reject, abort: null };
      job.abort = () => {
        const index = this.pending.indexOf(job);
        if (index >= 0) this.pending.splice(index, 1);
        reject(signal.reason || new Error("Inference cancelled."));
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      this.pending.push(job);
      this.drain();
    });
  }

  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.pending.length) {
        const job = this.pending.shift();
        job.signal?.removeEventListener("abort", job.abort);
        try {
          job.signal?.throwIfAborted();
          job.resolve(await job.work());
        } catch (error) {
          job.reject(error);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { InferenceQueue };
