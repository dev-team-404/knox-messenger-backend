import winston from 'winston';
import type { Request, Response, NextFunction } from 'express';

export const wlog = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, ...rest }) => {
      const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
      return `[${timestamp}] ${level.toUpperCase()}: ${message}${extra}`;
    }),
  ),
  transports: [new winston.transports.Console()],
});

export function requestLogger(req: Request, _res: Response, next: NextFunction): void {
  wlog.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    contentLength: req.headers['content-length'],
  });
  next();
}
