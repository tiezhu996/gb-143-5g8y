type Meta = unknown;

const format = (message: string): string => `[${new Date().toISOString()}] ${message}`;

export const logger = {
  info(message: string, meta?: Meta): void {
    if (meta === undefined) {
      console.log(format(message));
      return;
    }
    console.log(format(message), meta);
  },
  warn(message: string, meta?: Meta): void {
    if (meta === undefined) {
      console.warn(format(message));
      return;
    }
    console.warn(format(message), meta);
  },
  error(message: string, meta?: Meta): void {
    if (meta === undefined) {
      console.error(format(message));
      return;
    }
    console.error(format(message), meta);
  },
};
