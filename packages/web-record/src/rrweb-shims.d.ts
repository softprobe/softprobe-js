declare module "rrweb" {
  export function record(options: {
    emit: (event: unknown) => void;
    maskAllInputs?: boolean;
    [key: string]: unknown;
  }): (() => void) | undefined;
  export namespace record {
    function takeFullSnapshot(isCheckout?: boolean): void;
  }
  export function pack(data: unknown): string;
  export function unpack(data: string): unknown;
}

declare module "@rrweb/types" {
  export enum EventType {
    DomContentLoaded = 0,
    Load = 1,
    FullSnapshot = 2,
    IncrementalSnapshot = 3,
    Meta = 4,
    Custom = 5,
    Plugin = 6,
  }
  export type eventWithTime = {
    type: EventType | number;
    data: unknown;
    timestamp: number;
  };
}
