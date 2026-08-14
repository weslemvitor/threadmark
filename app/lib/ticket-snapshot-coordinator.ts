export type TicketSnapshot<T> = {
  detail: T;
  epoch: number;
};

type InFlightTicketSnapshot<T> = {
  epoch: number;
  promise: Promise<TicketSnapshot<T>>;
};

export class TicketSnapshotCoordinator<T> {
  private readonly epochs = new Map<string, number>();
  private readonly requests = new Map<string, InFlightTicketSnapshot<T>>();

  invalidate(ticketId: string): number {
    const nextEpoch = this.currentEpoch(ticketId) + 1;
    this.epochs.set(ticketId, nextEpoch);
    this.requests.delete(ticketId);
    return nextEpoch;
  }

  request(
    ticketId: string,
    load: (id: string) => Promise<T>,
  ): Promise<TicketSnapshot<T>> {
    const epoch = this.currentEpoch(ticketId);
    const existing = this.requests.get(ticketId);
    if (existing?.epoch === epoch) return existing.promise;

    const entry: InFlightTicketSnapshot<T> = {
      epoch,
      promise: load(ticketId).then((detail) => ({ detail, epoch })),
    };
    this.requests.set(ticketId, entry);

    const cleanup = () => {
      if (this.requests.get(ticketId) === entry) {
        this.requests.delete(ticketId);
      }
    };
    void entry.promise.then(cleanup, cleanup);
    return entry.promise;
  }

  isCurrent(ticketId: string, snapshot: TicketSnapshot<T>): boolean {
    return this.currentEpoch(ticketId) === snapshot.epoch;
  }

  forget(ticketId: string): void {
    this.requests.delete(ticketId);
    this.epochs.set(ticketId, this.currentEpoch(ticketId) + 1);
  }

  private currentEpoch(ticketId: string): number {
    return this.epochs.get(ticketId) ?? 0;
  }
}
