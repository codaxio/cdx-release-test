import { Command } from "commander";
import fs from "fs";
import { c, guessExtension, loadFile, loadFromDir, dd } from "./utils";
import pkg from "../package.json";

export async function cli() {
  const program = new Command()
  .name("cdx")
  .version(pkg.version)
  .description("CDX CLI")
  .option("-w, --cwd <path>", "Teleport to this directory")
  .option("-c, --config <config>", "Config file")
  .option("-l, --load <path...>", "Load commands from theses dirs or files")
  .action(async (options, command) => {
    dd("CDX CLI", options);
    let configFile = options.config || process.env.CDX_CONFIG || "cdx.config.ts";
    let config = await loadFile(guessExtension(configFile));
    dd(`Loading config from ${configFile}`, config);
    let commandsPath = options.load?.length ? options.load : (process.env.CDX_SCAN?.split(":") || ["./commands"])
    if (options.cwd) {
      process.chdir(options.cwd);
    }
    commandsPath = [...new Set(commandsPath)];
    commandsPath = await Promise.all(await commandsPath.map((path:string) => {
      if (path.startsWith("/")) return path;
      return `${process.cwd()}/${path}`;
    })
    .filter((commandPath:string) => {
      let exists = fs.existsSync(guessExtension(commandPath));
      if (!exists) {
        console.error(c.red(`Cannot load commands from ${commandPath}. File or directory does not exist.`));
      }
      return exists;
    })
    .map(async (commandPath:string) => {
      dd(`Loading commands from ${guessExtension(commandPath)}`);
      const isDir = fs.lstatSync(guessExtension(commandPath)).isDirectory();
      if (isDir) {
        let commands = await loadFromDir(commandPath);
        dd(`Found ${commands.length} commands in ${commandPath}`, commands);
        return commands;
      } else {
        let guessedPath = guessExtension(commandPath);
        dd(`Guessing ${guessedPath}`);
        let command = await loadFile(guessedPath);
        dd(`Found ${command.length} command in ${commandPath}`, command);
        return { command, name: String(commandPath.split(".").shift()?.split("/").pop()) };
      }
    })
    )

    if (!commandsPath.length) {
      command.help();
      return
    }
    let commands  = commandsPath.flat()
    dd(`Found commands `, commands);

    const program = new Command()
      .command("cdx")
      .description("Cozy Developer eXperience.")
      .action(async (data, command, c, d) => program.help())
    const argv = [process.argv[0], process.argv[1], ...command.args]

    let registration = await Promise.all(commands.map(async (cmd: 
      { command: any; name: string; }
    ) => {
      dd("Registering command", cmd)
      let Command = cmd.command
      let instance = new Command(program, config)
      await instance.register()
    }))
    program.parse(argv)
  })

  program.parse(process.argv);
}
