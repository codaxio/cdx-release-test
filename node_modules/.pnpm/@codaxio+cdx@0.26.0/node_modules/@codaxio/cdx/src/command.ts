import { Command } from "commander";
import defu from "defu";
import { execute, readJson,  writeJson } from "./utils";
import { type ExecSyncOptions } from 'child_process';
import type { Writable } from "stream";

export class BaseCommand {
  name: string = "BaseCommand";
  description: string = "Command";
  options: [string, string, any?][] = [
    ['-h, --help', 'Show help'],
  ]

  constructor(public program: Command, public config: Record<string, any>) {}

  async register() {
    const command = this.program.command(this.name).description(this.description);

    this.options.forEach((option) => command.option(option[0], option[1], option[2]));

    command.action(async (options, command) => {
     return await this.run(options, command)
    });

    return command;
  }

  async run(options: Record<string, any>, command: any) {
    throw new Error("Method run not implemented.")
  }

  async execute(command: string, options: ExecSyncOptions & {
    stdout?: Writable,
    stderr?: Writable
  } = { cwd: process.cwd() }) {
    return await execute(command, options);
  }

  readJson(path: string, defaultValue: Record<string, any> = {}) {
    return readJson(path, defaultValue);
  }

  writeJson(path: string, data: Record<string, any>) {
    writeJson(path, data);
  }

  getConfig(key: string) {
    // use dot notation to access nested properties
    return key.split('.').reduce((acc, k) => acc[k], this.config || {});
  }

  mergeConfig(config: Record<string, any>, key: string) {
    const final = defu(this.getConfig(key), config);
    key.split('.').reduce((acc, k, i, arr) => {
      if (i === arr.length - 1) {
        acc[k] = final;
        return acc;
      }
      acc[k] = acc[k] || {};
      return acc[k];
    }, this.config || {});
    return this.getConfig(key);
  }


  log(...args: any[]) {
    console.log(`${this.name}:`, ...args);
  }
}