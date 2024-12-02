# CDX

CDX is an on-the-fly CLI generators. Loads commands and a config file to generate a cli and execute commands.

## Installation

```bash
npm install @codaxio/cdx
```

# Usage


## Create a command

Create a `commands/` directory with a `hello.ts` file with the following content:

```ts
import { BaseCommand, c, readJson, writeJson, execute } from '../src';

export default class HelloCommand extends BaseCommand {
  name = 'hello';
  description = 'Say hello';
  options: [string, string, (string | boolean)?][] = [
    ['--name', 'Name to say hello to', 'world'],
  ];

  defaultConfig = {
    greeting: 'Hello',
  };

  async run(options: Record<string, any>, command: any) {
    const commandConfig = this.mergeConfig(this.defaultConfig, 'hello'); // Will merge hello key from cli.config.ts with defaultConfig

    console.log('Running command', commandConfig.greeting, options.name);

  }
}
```

Create a `cli.config.ts` file with the following content:

```ts


export default {
  hello: {
    greeting: "Hola"
  }
}

```


Invoke your commands with the following command:

```bash
npx cdx -l commands/ -c cli.config.ts -- hello --name "John"
```

