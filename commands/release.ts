import { BaseCommand, c, execute, readJson, writeJson, type CommandInput } from '@codaxio/cdx';
import fs, { writeFileSync } from 'fs';
import path from 'path';

export function log(...msg: unknown[]) {
  console.log(c.green('RELEASE'), '>', ...msg);
}


export type Release = {
  path: string;
  name: string;
  current: string;
  next: string;
  dependencies: {
    name: string;
    range: string;
  }[];
}

export type Commit = {
  hash: string;
  date: Date;
  type: string;
  scope: string;
  breaking: boolean;
  message: string;
  files: string[];
}

type PendingManifest = {
  releases: Record<string, Release>;
  commits: Commit[];
  files: string[];
}
export default class ReleaseCommand extends BaseCommand {
  name = 'release';
  description = 'Create a new release';
  options: [string, string, (string | boolean)?][] = [
    ['-t, --target <target>', 'The target branch'],
    ['-s, --source <source>', 'The source branch'],
    ['-b, --base [base]', 'The base branch', false],
    ['-n, --dry-run', 'Only print release', false],
    ['--pr [pr_id]', 'The PR id'],
    ['--publish', 'Publish all packages'],
  ];

  configKey = 'release';
  defaultConfig = {
    repository: '<owner>/<repo>',
    manifestPath: '.release-manifest.json',
    baseTarget: 'main',
    rootPackage: false,
    scan: [],
    pullRequest: {
      labels: {
        pending: 'autorelease: pending',
        ready: 'autorelease: ready',
        published: 'autorelease: published',
      },
      title: 'chore: release ${version}',
      header: ':robot: Autorelease',
      fix: '### Bug Fixes',
      feat: '### Features',
      docs: '### Documentation',
      test: '### Tests',
      chore: '### Chore',
      dependencies: '### Dependencies',
      other: '### Other Changes',
    },
    sections: ['feat', 'fix', 'docs', 'test'],
    hooks: {
      generateHeader: async ({
        release,
        year,
        month,
        day,
      }: {
        release: Release;
        year: string;
        month: string;
        day: string;
      }) => {
        let currentTag = await this.hooks.generateTag(release, release.current);
        let nextTag = await this.hooks.generateTag(release, release.next);
        return `## [${release.next}](https://github.com/${this.repository}/compare/${currentTag}...${nextTag} (${year}-${month}-${day})\n\n`;
      },
      generateTag: async (release: Release, version: string) => `${release.name}-v${version}`,
      onChangelog: async () => {},
      onScanFinished: async () => {},
      onPublish: async () => {},
    }
  };

  async run(inputs: CommandInput) {
    log(`Running release command with options:`);
    console.log(inputs.options)
    const manifest = await Manifest.init(inputs)
  }
}


export class Manifest {
  options: {
    target: string;
    source: string;
    base?: string;
    dryRun: boolean;
    pr: string | boolean;
    publish: boolean;
  }
  config: any;
  pending: PendingManifest = {
    releases: {},
    files: [],
    commits: []
  };
  constructor(inputs: CommandInput) {
    this.options = inputs.options as typeof this.options
    this.config = inputs.config
    this.pending = readJson(this.config.manifestPath, {});
  }

  static async init(inputs: CommandInput) {
    const manifest = new Manifest(inputs);
    if (manifest.options.publish == true)  await manifest.publish()
    else await manifest.generate()
    return manifest
  }

  async publish() {
    console.log('publishing', this.config)
    //if (!fs.existsSync(commandConfig.manifestPath)) {
    //  log('No manifest found, skipping release...');
    //  process.exit(0);
    //}
    //await execute(
    //  `git fetch origin ${options.target} 2> /dev/null || (git checkout -b ${options.target} origin/${commandConfig.baseTarget} && git push origin ${options.target})`,
    //);
    //console.log(await execute(`git checkout ${options.target}`))
    //log('Publishing packages...');
    //const manifest = JSON.parse(fs.readFileSync(commandConfig.manifestPath).toString());
    //await commandConfig.hooks.onPublish(manifest, commandConfig, options.pr);
    //process.exit(0);
  }

  async generate() {
    await this.reset()
    log(`Preparing release...`);
    await this._checkBranches()
    if (this.options.pr && this.options.pr !== true) await this.setLabel('autorelease: pending')
    await this._scanCommits()
    await this._checkImpactedPackages()
  }

  async reset() {
    if (this.pending.releases && Object.keys(this.pending.releases).length) {
      log('Resetting versions from pending manifest');
      for (const release of Object.values(this.pending.releases)) {
        this.setPackageVersion(release, release.current)
        this.resetChangelog(release)
      }

      this.pending.releases = {}
    }
  }

  async _checkImpactedPackages() {
    let root = []
    let packages = {}
    this.config.scan = this.config.scan.map((p) => path.resolve(p))
    this.pending.commits.forEach((commit) => {
      // Build the releases from the commit files. So if one commit has changes in multiple packages, we will build the release for each package. If we have a root package, we will build a release for it as well.
      // Extract the package name from the file path if it's in a scanned path
      const files = commit.files.filter((file) => this.config.scan.some((p) => file.startsWith(p)))
      if (!files.length && this.config.rootPackage) root.push(commit)
      else if (files.length) {
        let dirname = `${path.resolve('.')}/`
        files.forEach((file) => {
          let fromScan = this.config.scan.find((p: string) => file.startsWith(p))
          let packagePath = file.replace(`${fromScan}/`, '')
          console.log({file})
          console.log({fromScan})
          console.log({packagePath})
        })
      }
    })
  }

  async _scanCommits() {
    log(`Scanning commits from [${this.source}] to [${this.target}]...`);

    const commits = await execute(
      `git log --cherry-pick --format='%H %ct %s' --no-merges --left-only ${this.options.source}...${this.options.target}`,
    ).then((x) => x.stdout);
    this.pending.commits = await Promise.all(commits.trim().split('\n').map(this._extractCommitData.bind(this)));
    if (!this.pending.commits.length) {
      log('No commits found, skipping release...');
      process.exit(0);
    }

    log(`${c.blue(this.pending.commits.length)} commits found`);
    this.pending.files = this.pending.commits.flatMap((commit) => commit.files)
    .filter((file, i, a) => a.indexOf(file) === i);
    console.log(this.pending.files)
    log(`${c.blue(this.pending.files.length)} files changed`);
  }

  async _extractCommitData(commit: string) {
    const [hash, timestamp, ...message] = commit.split(' ');
    let date = new Date(Number(timestamp) * 1000);
    let scope = message.join(' ').split('(')[1]?.split(')')[0];
    let type = message.join(' ').split(':')[0].replace(`(${scope})`, '');
    let breaking = false
    if (type.includes('!')) { breaking = true; type = type.replace('!', ''); }
    return {
      hash,
      date,
      type,
      scope,
      breaking,
      message: message.join(' '),
      files: await this._getCommitFiles(hash)
    }
  }
    
  async _getCommitFiles(hash: string) {

    return await execute(
      `git diff-tree --no-commit-id --name-only --line-prefix=\`git rev-parse --show-toplevel\`/ -r ${hash}`,
    ).then((x) => x.stdout.trim().split('\n'));
  }

  async _checkBranches() {
    // We need to check if the target branch exists on the remote
    const targetBranch = await execute(`git fetch origin ${this.options.target} 2> /dev/null || echo false`).then((x) => x.stdout.trim());
    if (targetBranch === 'false') {
      log(`Branch ${this.target} does not exist, creating it...`);
      await execute(`git checkout -b ${this.options.target} origin/${this.options.base || this.config.baseTarget}`);
      await execute(`git push origin ${this.options.target}`);
    }
    const {status} = await execute(`git checkout ${this.options.target}`);
    if (status !== 0) {
      log(`Cannot checkout on ${this.target}...`);
      process.exit(1);
    }
    await execute(`git fetch origin ${this.options.source}`);
    await execute(`git checkout ${this.options.source}`);
  }


  setPackageVersion(release: Release, version: string) {
    const json = readJson(`${release.path}/package.json`);
    json.version = version;
    writeJson(`${release.path}/package.json`, json);
  }

  resetChangelog(release: Release) {
    if (!fs.existsSync(`${release.path}/CHANGELOG.md`)) return
    let changelog = fs.readFileSync(`${release.path}/CHANGELOG.md`).toString();
    let chunk = changelog.split(`## [${release.next}]`)
    if (chunk.length < 2) return
    let final = `## [${release.next}]${chunk[1].split('## [')[0]}` 
    writeFileSync(`${release.path}/CHANGELOG.md`, changelog.replace(final, ''));
  }

  async setLabel(label:string) {
    await execute(`gh pr edit ${this.options.pr} --add-label="${label}"`);
  }

  get source() {
    return `${c.green(this.options.source)}`
  }
  get target() {
    return `${c.blue(this.options.target)}`
  }
}


//function formatVersion(version: string, bump: 'major' | 'minor' | 'patch') {
//  const [major, minor, patch] = version.split('.').map(Number);
//  if (bump === 'major') {
//    return c.bold(`${c.red(`${major}`)}.${c.green(`0`)}.${c.yellow(`0`)}`);
//  } else if (bump === 'minor') {
//    return c.bold(`${major}.${c.green(`${minor}`)}.${c.yellow(`0`)}`);
//  } else {
//    return c.bold(`${major}.${minor}.${c.yellow(`${patch}`)}`);
//  }
//}

//export type ReleaseCommandOptions = {
//  repository: string;
//  manifestPath: string;
//  baseTarget: string;
//  rootPackage: boolean;
//  scan: string[];
//  pullRequest: {
//    labels: string[];
//    title: string;
//    header: string;
//    fix: string;
//    feat: string;
//    docs: string;
//    test: string;
//    chore: string;
//    dependencies: string;
//    other: string;
//  };
//  sections: string[];
//  hooks: {
//    generateHeader: (args: { release: Release; year: string; month: string; day: string }) => string;
//    generateTag: (release: Release, version: string) => string;
//    onChangelog: () => void;
//    onScanFinished: () => void;
//    onPublish: () => void;
//  };
//}



//export class Manifest {
//  path: string;
//  source: string = '';
//  target: string = '';
//  config: any;
//  changelog: string = '';
//  commits: Commit[] = [];
//  releases: Map<string, Release> = new Map();
//  constructor({ path }: { path: string }) {
//    this.path = path;
//    this.config = readJson(path);
//    if (this.config?.releases?.length) {
//      this.reset();
//    }
//  }

//  async generate({
//    source,
//    target,
//    hasRootPackage,
//    scan,
//  }: {
//    source: string;
//    target: string;
//    hasRootPackage: boolean;
//    scan: string[];
//  }) {
//    log(`Scanning commits between ${target} and ${source}...`);
//    this.target = target;
//    this.source = source;
//    if (hasRootPackage) {
//      this.releases.set(
//        '@root',
//        new Release({
//          path: '.',
//          name: '@root',
//        }),
//      );
//    }

//    const logs = await execute(
//      `git log --cherry-pick --format='%H %ct %s' --no-merges --left-only ${source}...origin/${target}`,
//    ).then((x) => x.stdout);
//    this.commits = await Promise.all(
//      logs
//        .split('\n')
//        .filter((log: string) => log)
//        .map(async (log: string) => {
//          const [hash, timestamp, ...message] = log.split(' ');
//          const commit = new Commit({ hash, timestamp, message: message.join(' ') });
//          await commit.getFiles(hash);
//          return commit;
//        }),
//    );
//    if (!this.commits.length) {
//      log('No commits found, skipping release...');
//      process.exit(0);
//    }
//    log(`${c.blue(this.commits.length)} commits found`);
//    const files = this.commits.flatMap((commit) => commit.files).filter((file, i, a) => a.indexOf(file) === i);
//    log(`${c.blue(files.length)} files changed`);

//    for (const commit of this.commits) {
//      await commit.checkImpact(
//        scan.map((p) => path.resolve(p)),
//        hasRootPackage,
//        this.releases,
//      );
//    }

//    const isPrerelease = this.target.includes('/pre-') ? this.target.split('/pre-')[1] : false;
//    const isHotfix = this.target.includes('/fix-') ? this.target.split('/fix-')[1] : false;

//    for (const release of this.releases.values()) {
//      release.next = await release.computeNewVersion(isPrerelease || isHotfix);
//    }

//    const maxLength = Math.max(...Array.from(this.releases.values()).map((release) => release.json.name.length));

//    Array.from(this.releases.values())
//      .filter((release) => {
//        if (release.commits.length) {
//          log(
//            `bumping ${c.bold(c.magenta(release.json.name))}`.padEnd((9 + maxLength) * 2, ' '),
//            `from ${c.bold(c.cyan(release.current.padEnd(8, ' ')))}`,
//            `to ${formatVersion(release.next, release.bump as Bump)}${release.next
//              .padEnd(8, ' ')
//              .replace(release.next, '')}`,
//            `[${c.green(
//              c[release.bump === 'major' ? 'red' : release.bump === 'minor' ? 'green' : 'yellow'](release.bump),
//            )}]`,
//          );
//          return true;
//        }
//        return false;
//      })
//      .forEach((release) => {
//        const dependencies = release.json.dependencies || {};
//        const devDependencies = release.json.devDependencies || {};
//        const peerDependencies = release.json.peerDependencies || {};
//        const allDependencies = { ...dependencies, ...devDependencies, ...peerDependencies };
//        for (const dep of Object.keys(allDependencies)) {
//          if (this.releases.has(dep)) {
//            release.addDependency(this.releases.get(dep) as Release, allDependencies[dep]);
//          }
//        }
//      });

//    return this;
//  }

//  async createOrUpdatePR({ options, commandConfig }: { options: Record<string, any>; commandConfig: any }) {
//    await execute('git add .');
//    await execute('git commit -m "chore: bump versions & update changelogs"');
//    const currentBranch = (await execute('git rev-parse --abbrev-ref HEAD')).stdout;
//    await execute(`git push --set-upstream origin ${currentBranch}`);
//    if (options.pr && options.pr !== true) {
//      log(`Updating PR: ${options.pr}`);
//      const prUrl = await execute(
//        `gh pr edit ${options.pr} --add-label "autorelease: ready" --remove-label "autorelease: pending" --body "${this.changelog}"`,
//      ).then((x) => x.stdout);
//      log(`PR updated: ${prUrl}`);
//    } else if (options.pr) {
//      const exists = await execute(
//        `gh pr list --state open -B ${this.target} -H ${currentBranch} --label="autorelease: pending" --json number,title,headRefName,baseRefName,labels | jq`,
//      ).then((x) => x.stdout);
//      console.log(exists);
//      if (exists && exists.length) {
//        const pr = JSON.parse(exists);
//        log(`Updating PR: ${pr[0].number}`);
//        const prUrl = await execute(
//          `gh pr edit ${pr[0].number} --add-label "autorelease: ready"  --remove-label "autorelease: pending" --body "${this.changelog}"`,
//        ).then((x) => x.stdout);
//        log(`PR updated: ${prUrl}`);
//      } else {
//        const pullRequest = await execute(
//          `gh pr create -B "${this.target}" --title "chore: release ${Array.from(this.releases.values())
//            .map((release) => release.json.name + '@' + release.next)
//            .join(', ')}" --body "${this.changelog}" --label "autorelease: ready"`,
//        ).then((x) => x.stdout);
//        log(`New PR created: ${pullRequest}`);
//      }
//    }
//  }

//  applyBumps() {
//    for (const release of this.releases.values()) {
//      const json = readJson(`${release.path}/package.json`);
//      json.version = release.next;
//      writeJson(`${release.path}/package.json`, json);
//    }
//    return this;
//  }

//  updateChangelogs() {
//    for (const release of this.releases.values()) {
//      if (!fs.existsSync(`${release.path}/CHANGELOG.md`)) {
//        fs.writeFileSync(`${release.path}/CHANGELOG.md`, release.changelog);
//        return this;
//      }
//      const changelog = fs.readFileSync(`${release.path}/CHANGELOG.md`).toString();
//      fs.writeFileSync(`${release.path}/CHANGELOG.md`, `${release.changelog}\n${changelog}`);
//    }

//    return this;
//  }

//  resetChangelogs() {
//    for (const release of this.releases.values()) {
//      if (!fs.existsSync(`${release.path}/CHANGELOG.md`)) {
//        fs.writeFileSync(`${release.path}/CHANGELOG.md`, '');
//        return;
//      }
//      let changelog = fs.readFileSync(`${release.path}/CHANGELOG.md`).toString();
//      changelog = changelog.replace(release.changelog + '\n', '');
//      fs.writeFileSync(`${release.path}/CHANGELOG.md`, changelog);
//    }

//    return this;
//  }

//  save() {
//    fs.writeFileSync(
//      this.path,
//      JSON.stringify(
//        {
//          releases: [...this.releases.values()].map((release) => {
//            return {
//              path: release.path,
//              current: release.current,
//              next: release.next,
//              name: release.name,
//              changelog: release.changelog,
//              dependencies: release.dependencies.map((dep) => {
//                return {
//                  previous: dep.range,
//                  path: dep.path,
//                  current: dep.current,
//                  next: dep.next,
//                  nextRange: dep.nextRange,
//                  name: dep.name,
//                };
//              }),
//            };
//          }),
//        },
//        null,
//        2,
//      ),
//    );

//    return this;
//  }

//  async generateChangelog({
//    year,
//    month,
//    day,
//    commandConfig,
//  }: {
//    year: string;
//    month: string;
//    day: string;
//    commandConfig: any;
//  }) {
//    log('Generating changelog');
//    await Promise.all(
//      Array.from(this.releases.values()).map(async (release) =>
//        release.generateChangelog({ year, month, day, commandConfig }),
//      ),
//    );

//    this.changelog = '';
//    this.changelog += `${commandConfig.pullRequest.header}
//---
//`;
//    this.releases.forEach((release) => {
//      this.changelog += `\n<details><summary>${release.json.name}: ${release.current} > ${release.next}</summary>
//${release.changelog}
//</details>`;
//    });

//    await commandConfig.hooks.onChangelog(this);
//  }

//  async reset() {
//    log('Resetting from previous manifest');
//    if (this.config?.releases) {
//      this.releases = this.config.releases.map((release: any) => {
//        release.next = release.current;
//        return release;
//      });
//      this.applyBumps().resetChangelogs();
//      this.releases = new Map();
//    }
//  }
//}

//export type Bump = 'major' | 'minor' | 'patch';

//export class Release {
//  name: string;
//  path: string;
//  range: string = '';
//  nextRange: string = '';
//  current: string;
//  next: string = '';
//  changelog: string = '';
//  bump: Bump | false = false;
//  commits: Commit[] = [];
//  dependencies: Release[] = [];
//  json: any;
//  constructor({ path, name }: { path: string; name: string }) {
//    this.path = path;
//    this.name = name;
//    this.json = readJson(this.path + '/package.json');
//    this.current = this.json.version || '0.0.0';
//  }

//  async addCommit(commit: Commit) {
//    this.commits.push(commit);
//    if (commit.breaking) this.bump = 'major';
//    if (commit.type == 'feat' && this.bump != 'major') this.bump = 'minor';
//    if (this.bump == false) this.bump = 'patch';
//  }

//  addDependency(release: Release, range: string) {
//    if (release.next != '') {
//      if (range === 'workspace:*') {
//        release.range = range;
//        release.nextRange = release.next;
//        this.dependencies.push(release);
//        log(
//          `${c.bold(c.magenta(this.json.name))}: bumping ${c.green(
//            release.json.name,
//          )} from workspace to ${formatVersion(release.next, release.bump as Bump)!} [${c.bold(
//            c[release.bump === 'major' ? 'red' : release.bump === 'minor' ? 'green' : 'yellow'](release.bump),
//          )}]`,
//        );
//        return;
//      }
//      if (!/^[\^~]/.test(range as string)) {
//        log(
//          `${c.bold(c.magenta(this.json.name))}: skipping bump of ${
//            release.json.name
//          } because version is fixed: ${range}`,
//        );
//        return;
//      }
//      if (String(range).startsWith('~') && release.bump == 'patch') {
//        release.range = range;
//        release.nextRange = `~${release.next}`;
//        this.dependencies.push(release);
//        log(
//          `${c.bold(c.magenta(this.json.name))}: bumping ${c.green(release.json.name)} from ${c.bold(
//            c.blue(range),
//          )} to ~${formatVersion(release.next, release.bump)} [${c.bold(c['yellow'](release.bump))}]`,
//        );
//      }
//      if (String(range).startsWith('^') && ['minor', 'patch'].includes(release.bump as Bump)) {
//        release.range = range;
//        release.nextRange = `^${release.next}`;
//        this.dependencies.push(release);
//        log(
//          `${c.bold(c.magenta(this.json.name))}: bumping ${c.green(release.json.name)} from ${c.bold(
//            c.blue(range),
//          )} to ^${formatVersion(release.next, release.bump as Bump)} [${c.bold(
//            c[release.bump === 'major' ? 'red' : release.bump === 'minor' ? 'green' : 'yellow'](release.bump),
//          )}]`,
//        );
//      }
//    }
//  }

//  async computeNewVersion(isPrerelease: string | false) {
//    const { stdout } = await execute(
//      `pnpm version ${isPrerelease ? `prerelease` : this.bump} ${
//        isPrerelease ? `--preid=${isPrerelease}` : ''
//      } --no-git-tag-version --allow-same-version`,
//      {
//        cwd: this.path,
//      },
//    );
//    writeJson(this.path + '/package.json', {
//      ...this.json,
//      version: this.current,
//    });
//    return stdout.trim().replace(/^v/, '');
//  }

//  async generateChangelog({
//    year,
//    month,
//    day,
//    commandConfig,
//  }: {
//    year: string;
//    month: string;
//    day: string;
//    commandConfig: any;
//  }) {
//    this.changelog = '\n';
//    this.changelog += await commandConfig.hooks.generate.header({ release: this, year, month, day, commandConfig });

//    const sections = commandConfig.sections.map((section: string) => {
//      return {
//        section,
//        commits: this.commits.filter((commit: Commit) => commit.type === section),
//      };
//    });
//    const others = this.commits.filter((commit: Commit) => !commandConfig.sections.includes(commit.type));
//    if (others.length) {
//      sections.push({
//        section: 'other',
//        commits: others,
//      });
//    }
//    sections.forEach((section: { section: string; commits: Commit[] }) => {
//      if (!section.commits.length) return;
//      if (section.commits?.length) {
//        this.changelog += `${commandConfig.pullRequest[section.section as keyof typeof commandConfig.pullRequest]}\n\n`;
//        for (const commit of section.commits) {
//          this.changelog += `* ${commit.message} ([${commit.hash.slice(0, 7)}](https://github.com/${
//            commandConfig.repository
//          }/commit/${commit.hash}))\n`;
//        }
//        this.changelog += '\n';
//      }
//    });

//    if (this.dependencies.length) {
//      this.changelog += `${commandConfig.pullRequest.dependencies}\n\n`;
//      this.changelog += '* The following workspace dependencies were updated\n';
//      for (const [dep, current, next] of this.dependencies.map((dep) => [dep.name, dep.current, dep.next])) {
//        this.changelog += `    * ${dep} bumped from ${current} to ${next}\n`;
//      }
//    }

//    return this.changelog;
//  }
//}

//export class Commit {
//  hash: string;
//  date: Date;
//  message: string;
//  scope: string;
//  type: string;
//  breaking: boolean;
//  files: string[] = [];

//  constructor({ hash, timestamp, message }: { hash: string; timestamp: string; message: string }) {
//    this.hash = hash;
//    this.date = new Date(Number(timestamp) * 1000);
//    this.message = message;
//    this.scope = message.split('(')[1]?.split(')')[0];
//    this.type = message.split(':')[0].replace(`(${this.scope})`, '');
//    this.breaking = this.type.includes('!');
//    if (this.breaking) {
//      this.type = this.type.replace('!', '');
//    }
//  }

//  async getFiles(hash: string) {
//    this.files = await execute(
//      `git diff-tree --no-commit-id --name-only --line-prefix=\`git rev-parse --show-toplevel\`/ -r ${hash}`,
//    ).then((x) => x.stdout.split('\n').filter((x) => x));
//  }

//  async checkImpact(scan: string[], hasRootPackage: boolean, releases: Map<string, Release>) {
//    const packagesFiles = this.files.filter((file) => scan.some((p) => file.startsWith(p)));
//    if (!packagesFiles.length && hasRootPackage) {
//      await releases.get('@root')?.addCommit(this);
//    } else {
//      const packages = new Map<string, { name: string; path: string }>();
//      for (const file of packagesFiles) {
//        const pkg = scan.find((p) => file.startsWith(p));
//        const pkgRoot = pkg?.split('/').pop();
//        const pkgFile = file.replace(pkg + '/', '');
//        const pkgName = pkgFile.split('/')[0];
//        if (!packages.has(pkgName)) {
//          packages.set(pkgName, {
//            path: `${pkgRoot}/${pkgName}`,
//            name: pkgName,
//          });
//        }
//      }
//      packages.forEach((pkg) => {
//        if (!releases.has(pkg.name)) {
//          releases.set(pkg.name, new Release(pkg));
//        }
//        releases.get(pkg.name)?.addCommit(this);
//      });
//    }
//  }
//}
