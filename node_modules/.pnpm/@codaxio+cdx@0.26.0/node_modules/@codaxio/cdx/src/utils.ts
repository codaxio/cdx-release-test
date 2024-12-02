import { spawn,exec, type ExecSyncOptions, type ExecException } from 'child_process';
import fs from 'fs';
import chalk from 'chalk';
import { Writable } from 'stream';

class MemoryWritable extends Writable {
    _output: string;
    highWaterMark: number;
    live: boolean;
    constructor(options: any) {
      super({ ...options, objectMode: true });
      this.live = options.live || false;
      this.highWaterMark = options.highWaterMark || 2;
      this._output = ''
    }
    _write(chunk: string, encoding: string, callback?: (error: Error | null | undefined) => void) {
      this._output+=chunk.toString();
      this.live && process.stdout.write(chunk);
    }
    _final() {
      return this._output;
    }
  }

export function createMemoryStream(options: { live: boolean }) { 
  return new MemoryWritable(options);
}

export async function run(command: string, options: { 
  cwd?: string,
  live?: boolean
} = {
  live: false,
  cwd: process.cwd(),
}): Promise<string> {
 return new Promise((resolve, reject) => {
  var outputStream = createMemoryStream({ live: options.live === true });
  const child = spawn(command, { shell: true, cwd: options.cwd });

  child.stdout.pipe(outputStream);
  child.on('close', function(code) {
    if (code === 0) {
      resolve(outputStream._final());
    } else {
      reject(new Error(`Command failed with code ${code}`));
    }
  }
  );
  child.stderr.on('data', function(data) { 
    console.log("Error running command", command, data.toString());
    outputStream.write(c.red(data.toString()));
  });
  });
}


const IS_DEBUG = process.env.DEBUG === "true";
export const dd = (...args: any[]) => IS_DEBUG && console.log(...args);
export const padBetween = function(left: string, right: string, padding = 30) {
  return left.padEnd(padding + left.length, ' ') + right.trim();
}


export const executeSync =  async (command: string, options: ExecSyncOptions & {
  stdout?: Writable,
  stderr?: Writable
} = { cwd: process.cwd() }) : Promise<{
  stdout: string
  stderr: string
  err: ExecException | null
  status: number | undefined
}> => {
  const state = {
    stdout: '',
    stderr: '',
    err: null,
    status: undefined
  } as {
    stdout: string,
    stderr: string,
    err: ExecException | null,
    status: number | undefined
  }
  return await new Promise((resolve, reject) => {
      const child = exec(command, options,
          (err, stdout, stderr) => {
            state.err = err
            state.stdout = stdout
            state.stderr = stderr
            state.err = err
            resolve(state)
          })
      .on("exit", (code) => { 
        state.status = code || 0
      })

      if (options.stdout) {
          child.stdout?.pipe(options.stdout);
      }
      if (options.stderr) {
          child.stderr?.pipe(options.stderr);
      }
  });
}

export const execute = async (command: string, options: ExecSyncOptions & {
  stdout?: Writable,
  stderr?: Writable
} = { cwd: process.cwd() }) => {
  let { stdout, stderr, err, status } = await executeSync(command, options)
  if (err) {
    console.error(c.red(err.message))
    return { stdout, stderr, status }
  }
  return { stdout, stderr, status }
}

export const readJson = (path: string, def = {}) => {
  try {
    return JSON.parse(fs.readFileSync(path).toString());
  } catch (e) {
    return def;
  }
}

export const writeJson = (path: string, data: Record<string, any>) => {
  fs.writeFileSync(path, JSON.stringify(data, null, 2)  + '\n');
}
export const loadFile = async(path: string)=> {
  let content

  switch (path.split(".").pop()) {
    case "yml":
    case "yaml":
      let yaml = await run(`yq ${path} -o json`)
      content = JSON.parse(String(yaml))
      break
    case "json":
      let json = JSON.parse(fs.readFileSync(path).toString())
      content = json
      break
    case "ts":
    case "js":
      if (!path.startsWith("/")) path = `${process.cwd()}/${path}`
      const _module = await import(`${path}`)
      content = _module.default
      break
  }

  return content
}
export const loadBarrelFile = async(path: string)=> {
  let commands = []
  let content = await loadFile(path)
  if (content && Object.keys(content).length) {
    for (let [name, command] of Object.entries(content)) {
       commands.push({ name, command })
    }
  } else {
    console.error("No commands found in", path)
  }
  return commands
}

export const loadFromDir = async (dir: string): Promise<{ name: string, command: any }[]>=> {

  let commands = [] as { name: string, command: any }[]
  let files = fs.readdirSync(dir)
  if (files.includes("index.ts")) commands.push(...(await loadBarrelFile(`${dir}/index.ts`))) 
  else if (files.includes("index.js")) commands.push(...(await loadBarrelFile(`${dir}/index.js`))) 
  else {
    for (let file of files) {
      let path = `${dir}/${file}`
      let isDir = fs.lstatSync(path).isDirectory()
      if (isDir) commands.push(...(await loadFromDir(path)))
      else commands.push({ name: String(file.split(".").shift()
        || `command-${commands.length}`
      ), command: await loadFile(path) })
    }
  }

  return commands
}

export const guessExtension = (path: string, allowedExtensions: string[] = [".ts", ".js", ".json", ".yaml", ".yml"]) => {
  if (fs.existsSync(path)) return path
  let hasExtension = /\.(json|ts|js|yaml|yml)$/.test(path.toLowerCase())
  if (!hasExtension) {
    let extension = allowedExtensions.find((ext) => fs.existsSync(path + ext))
    path += extension || ""
  }
  return path
}
export const c = {
  blue: chalk.blue,
  red: chalk.red,
  green: chalk.green,
  yellow: chalk.yellow,
  cyan: chalk.cyan,
  magenta: chalk.magenta,
  white: chalk.white,
  gray: chalk.gray,
  bold: chalk.bold,
  underline: chalk.underline,
  italic: chalk.italic,
  dim: chalk.dim,
  bgBlue: chalk.bgBlue,
  bgRed: chalk.bgRed,
  bgGreen: chalk.bgGreen,
  bgYellow: chalk.bgYellow,
  bgCyan: chalk.bgCyan,
  bgMagenta: chalk.bgMagenta,
  bgWhite: chalk.bgWhite,
  bgGray: chalk.bgGray,
  bgBlack: chalk.bgBlack,
  bgRgb: chalk.bgRgb,
  rgb: chalk.rgb,
  hex: chalk.hex,
  bgHex: chalk.bgHex,
}