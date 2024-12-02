import { Command } from 'commander';
import { ExecSyncOptions, ExecException } from 'child_process';
import { Writable } from 'stream';
import * as chalk from 'chalk';

declare class BaseCommand {
    program: Command;
    config: Record<string, any>;
    name: string;
    description: string;
    options: [string, string, any?][];
    constructor(program: Command, config: Record<string, any>);
    register(): Promise<Command>;
    run(options: Record<string, any>, command: any): Promise<void>;
    execute(command: string, options?: ExecSyncOptions & {
        stdout?: Writable;
        stderr?: Writable;
    }): Promise<{
        stdout: string;
        stderr: string;
        status: number | undefined;
    }>;
    readJson(path: string, defaultValue?: Record<string, any>): any;
    writeJson(path: string, data: Record<string, any>): void;
    getConfig(key: string): Record<string, any>;
    mergeConfig(config: Record<string, any>, key: string): Record<string, any>;
    log(...args: any[]): void;
}

declare class MemoryWritable extends Writable {
    _output: string;
    highWaterMark: number;
    live: boolean;
    constructor(options: any);
    _write(chunk: string, encoding: string, callback?: (error: Error | null | undefined) => void): void;
    _final(): string;
}
declare function createMemoryStream(options: {
    live: boolean;
}): MemoryWritable;
declare function run(command: string, options?: {
    cwd?: string;
    live?: boolean;
}): Promise<string>;
declare const dd: (...args: any[]) => false | void;
declare const padBetween: (left: string, right: string, padding?: number) => string;
declare const executeSync: (command: string, options?: ExecSyncOptions & {
    stdout?: Writable;
    stderr?: Writable;
}) => Promise<{
    stdout: string;
    stderr: string;
    err: ExecException | null;
    status: number | undefined;
}>;
declare const execute: (command: string, options?: ExecSyncOptions & {
    stdout?: Writable;
    stderr?: Writable;
}) => Promise<{
    stdout: string;
    stderr: string;
    status: number | undefined;
}>;
declare const readJson: (path: string, def?: {}) => any;
declare const writeJson: (path: string, data: Record<string, any>) => void;
declare const loadFile: (path: string) => Promise<any>;
declare const loadBarrelFile: (path: string) => Promise<{
    name: string;
    command: unknown;
}[]>;
declare const loadFromDir: (dir: string) => Promise<{
    name: string;
    command: any;
}[]>;
declare const guessExtension: (path: string, allowedExtensions?: string[]) => string;
declare const c: {
    blue: chalk.ChalkInstance;
    red: chalk.ChalkInstance;
    green: chalk.ChalkInstance;
    yellow: chalk.ChalkInstance;
    cyan: chalk.ChalkInstance;
    magenta: chalk.ChalkInstance;
    white: chalk.ChalkInstance;
    gray: chalk.ChalkInstance;
    bold: chalk.ChalkInstance;
    underline: chalk.ChalkInstance;
    italic: chalk.ChalkInstance;
    dim: chalk.ChalkInstance;
    bgBlue: chalk.ChalkInstance;
    bgRed: chalk.ChalkInstance;
    bgGreen: chalk.ChalkInstance;
    bgYellow: chalk.ChalkInstance;
    bgCyan: chalk.ChalkInstance;
    bgMagenta: chalk.ChalkInstance;
    bgWhite: chalk.ChalkInstance;
    bgGray: chalk.ChalkInstance;
    bgBlack: chalk.ChalkInstance;
    bgRgb: (red: number, green: number, blue: number) => chalk.ChalkInstance;
    rgb: (red: number, green: number, blue: number) => chalk.ChalkInstance;
    hex: (color: string) => chalk.ChalkInstance;
    bgHex: (color: string) => chalk.ChalkInstance;
};

declare function cli(): Promise<void>;

export { BaseCommand, c, cli, createMemoryStream, dd, execute, executeSync, guessExtension, loadBarrelFile, loadFile, loadFromDir, padBetween, readJson, run, writeJson };
