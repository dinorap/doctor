import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { format } from 'util';
import CONFIG from '../config';

// Ensure logs directory exists
if (!fs.existsSync(CONFIG.paths.logs)) {
    fs.mkdirSync(CONFIG.paths.logs, { recursive: true });
}

const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        let output = `${timestamp} [${level.toUpperCase()}]: ${message}`;
        // Include any additional meta data
        const cleanMeta = Object.fromEntries(
            Object.entries(meta).filter(([k]) => k !== 'level' && k !== 'timestamp')
        );
        if (Object.keys(cleanMeta).length > 0) {
            output += ' ' + JSON.stringify(cleanMeta);
        }
        return output;
    })
);

// Wrap the underlying logger so calls like `logger.info('hello %s', 'world')`
// behave like console.log / util.format — winston's default logger does NOT
// perform printf-style substitution; it treats the trailing arguments as
// meta keys, which is why we were seeing literal "%s" in the output.
const baseLogger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: logFormat,
    transports: [
        // Console transport
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                logFormat
            ),
        }),
        // File transport - all logs
        new winston.transports.File({
            filename: path.join(CONFIG.paths.logs, 'combined.log'),
            maxsize: 10 * 1024 * 1024, // 10MB
            maxFiles: 5,
        }),
        // File transport - errors only
        new winston.transports.File({
            filename: path.join(CONFIG.paths.logs, 'error.log'),
            level: 'error',
            maxsize: 10 * 1024 * 1024, // 10MB
            maxFiles: 5,
        }),
    ],
});

const LEVELS = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'] as const;
type Level = typeof LEVELS[number];

function build(level: Level) {
    return (msg: any, ...args: any[]) => {
        if (args.length === 0) {
            baseLogger.log(level, msg);
            return;
        }
        // Sprintf-style: format(msg, ...args) so callers can keep using
        // `logger.info('hello %s', 'world')` from console.log muscle memory.
        const formatted = format(msg, ...args);
        baseLogger.log(level, formatted);
    };
}

export const logger = {
    error: build('error'),
    warn: build('warn'),
    info: build('info'),
    http: build('http'),
    verbose: build('verbose'),
    debug: build('debug'),
    silly: build('silly'),
    log: baseLogger.log.bind(baseLogger),
    child: baseLogger.child.bind(baseLogger),
} as unknown as winston.Logger;

export default logger as winston.Logger;
