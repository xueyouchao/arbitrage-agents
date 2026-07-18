import { PmxtReadParityBatch, PmxtReadParityRepository } from "./pmxt-read-parity";

export class InMemoryPmxtReadParityRepository implements PmxtReadParityRepository {
  readonly batches: PmxtReadParityBatch[] = [];

  async saveBatch(batch: PmxtReadParityBatch): Promise<void> {
    this.batches.push(batch);
  }
}
