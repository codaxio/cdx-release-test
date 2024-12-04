import { BaseCommand, c, execute, readJson, writeJson, type CommandInput } from '@codaxio/cdx';
import fs, { writeFileSync } from 'fs';
import path from 'path';

export function log(...msg: unknown[]) {
  console.log(c.green('RELEASE'), '>', ...msg);
}

export type Bump = 'major' | 'minor' | 'patch' | false;


export type Package = {
  commits: Commit[];
  json: Record<string, any>;
  path: string;
  name: string;
  current: string;
  changelog: string;
  next: string;
  bump: Bump;
  dependencies: {
    name: string;
    range: string;
  }[];
}
export type Release = {
  name: string;
  path: string;
  current: string;
  next: string;
  dependencies: {
    base: { name: string; range: string }[];
    dev: { name: string; range: string }[];
    peer: { name: string; range: string }[];
  };
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
  packages: Record<string, Package>;
  releases: Record<string, Release>;
  commits: Commit[];
  files: string[];
}


export type ReleaseCommandConfig = {
  repository: string;
  manifestPath: string;
  baseTarget: string;
  rootPackage: boolean;
  scan: string[];
  pullRequest: {
    labels: {
      pending: string;
      ready: string;
      published: string;
    };
    title: string;
    header: string;
    fix: string;
    feat: string;
    docs: string;
    test: string;
    chore: string;
    dependencies: string;
    other: string;
  };
  sections: string[];
  hooks: {
    generateHeader: (args: { release: Release; year: string; month: string; day: string, config: ReleaseCommandConfig }) => Promise<string>;
    generateTag: (release: Release, version: string) => Promise<string>;
    onScanFinished: (manifest: PendingManifest) => Promise<void>;
    onChangelog: (changelog: string) => Promise<void>;
    onPublish: () => Promise<void>;
  };
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
  defaultConfig: ReleaseCommandConfig = {
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
        config,
      }: {
        release: Release;
        year: string;
        month: string;
        day: string;
        config: ReleaseCommandConfig;
      }) => {
        let currentTag = await config.hooks.generateTag(release, release.current);
        let nextTag = await config.hooks.generateTag(release, release.next);
        return `## [${release.next}](https://github.com/${config.repository}/compare/${currentTag}...${nextTag} (${year}-${month}-${day})\n\n`;
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
  changelog: string = '';
  config: ReleaseCommandConfig;
  pending: PendingManifest = {
    packages: {},
    releases: {},
    files: [],
    commits: []
  };
  constructor(inputs: CommandInput) {
    this.options = inputs.options as typeof this.options
    this.config = inputs.config as ReleaseCommandConfig
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
    await this._computeNewVersion()
    await this._printBumps()
    await this._checkDependencies()
    await this.config.hooks.onScanFinished(this.pending);
    await this._updateChangelogs()
    if (this.options.dryRun) return log('Dry run enabled, skipping release...');
    await this._saveManifest()
    await this._saveChangelogs()
    await this._createOrUpdatePR()
  }

  async reset() {
    if (this.pending.releases && Object.keys(this.pending.releases).length) {
      log('Resetting versions from pending manifest');
      for (const release of Object.values(this.pending.releases)) {
        this.setPackageVersion(release, release.current)
        this.resetChangelog(release)
      }

    }
    this.pending = {
      packages: {},
      releases: {},
      files: [],
      commits: []
    }
  }

  async _saveChangelogs() {
    return await Promise.all(Object.values(this.pending.releases).map(async (release) => {
      let pkg = this.pending.packages[release.name]
      if (!fs.existsSync(`${pkg.path}/CHANGELOG.md`)) {
        fs.writeFileSync(`${pkg.path}/CHANGELOG.md`, pkg.changelog);
        return this;
      }
      const changelog = fs.readFileSync(`${pkg.path}/CHANGELOG.md`).toString();
      fs.writeFileSync(`${pkg.path}/CHANGELOG.md`, `${pkg.changelog}\n${changelog}`);
    }))
  }

  async _createOrUpdatePR() {
    await execute('git add .');
    await execute('git commit -m "chore: bump versions & update changelogs"');
    const currentBranch = (await execute('git rev-parse --abbrev-ref HEAD')).stdout.trim();
    await execute(`git push --set-upstream origin ${currentBranch}`);
    if (this.options.pr === true) {
      await this._handleCreatePR(currentBranch)
    } else if (this.options.pr !== false) {
      log(`Updating PR [${c.blue(this.options.pr)}]`);
      const pullRequest = await execute(
        `gh pr edit ${this.options.pr} --add-label "autorelease: ready" --remove-label "autorelease: pending" --body "${this.changelog}"`,
      ).then((x) => x.stdout);
      log(`PR updated: ${pullRequest}`);
    }
  }

  async _handleCreatePR(currentBranch: string) {
    let pr = await this._findPR(currentBranch)
    if (pr) {
      log(`Updating PR [${c.blue(pr.number)}]`);
      const pullRequest = await execute(`gh pr edit ${pr.number} --add-label "${this.config.pullRequest.labels.ready}" --remove-label "${this.config.pullRequest.labels.pending}" --body "${this.changelog}" 2 > &1`).then((x) => x.stdout);
      log(`PR updated: ${pullRequest}`);
    } else {
      const pullRequest = await execute(
        `gh pr create -B "${this.options.target}" --title "chore: release ${Object.values(this.pending.releases)
          .map((release) => release.name + '@' + release.next)
          .join(', ')}" --body "${this.changelog}" --label "${this.config.pullRequest.labels.ready}"`,
      ).then((x) => x.stdout);
      log(`New PR created: ${pullRequest}`);
    }
  }
  async _findPR(currentBranch: string) {
    let exists = await execute(
      `gh pr list --state open -B ${this.options.target} -H ${currentBranch} --json number,title,headRefName,baseRefName,labels | jq`,
    ).then((x) => x.stdout.trim());
    if (exists && exists.length) {
      return JSON.parse(exists)?.[0];
    }
    return false
  }

  _saveManifest() {
    writeJson(this.config.manifestPath, this.pending);
  }

  async _updateChangelogs() {
    const [year, month, day] = new Date().toISOString().split('T')[0].split('-');
    log('Generating changelog');
    let promises = Object.values(this.pending.releases).map(async (release) => {
        return this._generateChangelog({ year, month, day, release })
    })
    await Promise.all(promises);

    this.changelog = '';
    this.changelog += `${this.config.pullRequest.header}
---
`;
    Object.values(this.pending.packages).forEach((release) => {
      if (!release.bump) return
      this.changelog += `\n<details><summary>${release.json.name}: ${release.current} > ${release.next}</summary>
${release.changelog}
</details>`;
    });

    await this.config.hooks.onChangelog(this.changelog);

  }

  async _generateChangelog({
    year,
    month,
    day,
    release,
  }: {
    year: string;
    month: string;
    day: string;
    release: Release;
  }) {
    let pkg = this.pending.packages[release.name]
    pkg.changelog = '\n';
    pkg.changelog += await this.config.hooks.generateHeader({ release: release, year, month, day, config: this.config });

    const sections = this.config.sections.map((section: string) => {
      return {
        section,
        commits: this.pending.commits.filter((commit: Commit) => commit.type === section),
      };
    });
    const others = this.pending.commits.filter((commit: Commit) => !this.config.sections.includes(commit.type));
    if (others.length) {
      sections.push({
        section: 'other',
        commits: others,
      });
    }
    sections.forEach((section: { section: string; commits: Commit[] }) => {
      if (!section.commits.length) return;
      if (section.commits?.length) {
        pkg.changelog += `${this.config.pullRequest[section.section as keyof typeof this.config.pullRequest]}\n\n`;
        for (const commit of section.commits) {
          pkg.changelog += `* ${commit.message} ([${commit.hash.slice(0, 7)}](https://github.com/${
            this.config.repository
          }/commit/${commit.hash}))\n`;
        }
        pkg.changelog += '\n';
      }
    });
    Object.keys(release.dependencies).forEach((depType) => {
      let deps = release.dependencies[depType as keyof typeof release.dependencies]
      if (deps.length) {
        pkg.changelog += `${this.config.pullRequest.dependencies}\n\n`;
        pkg.changelog += '* The following workspace dependencies were updated\n';
        for (const dep of deps) {
          let depPkg = this.pending.packages[dep.name]
          pkg.changelog += `    * ${depPkg.name} bumped from ${dep.range} to ${depPkg.next}\n`;
        }
      }
    })

    return pkg.changelog;
  }

  async _checkDependencies() {
    this.pending.releases = Object.values(this.pending.packages).reduce((acc, pkg) => {
      if(pkg.bump === false) return acc
      acc[pkg.name] = {
        path: pkg.path,
        name: pkg.name,
        current: pkg.current,
        next: pkg.next,
        dependencies: {
          base: [],
          dev: [],
          peer: []
        }
      }
      return acc
    }, {} as Record<string, Release>)
    const releasedPackages = Object.keys(this.pending.releases)
    for (const release of Object.values(this.pending.releases)) {
      const json  = this.pending.packages[release.name].json
      release.dependencies = {
        base: this.hasInternalDependency(releasedPackages, json.dependencies),
        dev: this.hasInternalDependency(releasedPackages, json.devDependencies),
        peer: this.hasInternalDependency(releasedPackages, json.peerDependencies),
      }
    }

    let releaseCount = Object.keys(this.pending.releases).length
    if (!releaseCount) {
      log('No packages to release, skipping...');
      return;
    }
    log(`Preparing ${releaseCount} release${releaseCount ? 's' : ''}...`);
  }

  hasInternalDependency(releasedPackages: string[], deps: Record<string, string>) {
    if (!deps) return []

    return Object.keys(deps).filter((dep) => releasedPackages.includes(dep)).map((dep) => {
      return {
        name: dep,
        range: deps[dep]
      }
    })
  }

  async _printBumps() {
    for (const pkg of Object.values(this.pending.packages)) {
      if (pkg.bump === false) continue
      log(
        `bumping ${c.bold(c.magenta(pkg.name).padEnd(40, ' '))} from ${c.bold(c.cyan(pkg.current.padEnd(8, ' ')))} to ${c.bold(c.green(pkg.next.padEnd(8, ' ')))} [${c.green(c[pkg.bump === 'major' ? 'red' : pkg.bump === 'minor' ? 'green' : 'yellow'](pkg.bump))}]`,
      );
    }
  }
  async _computeNewVersion() {
    const isPrerelease = this.options.target.includes('/pre-') ? this.options.target.split('/pre-')[1] : false;
    const isHotfix = this.options.target.includes('/fix-') ? this.options.target.split('/fix-')[1] : (
      this.options.source.includes('fix/') ? this.options.source.split('fix/')[1] : false
    )
    let promises = Object.values(this.pending.packages).map(async (pkg) => {
      if (pkg.bump === false) return
      let bump: string = pkg.bump
      if (isPrerelease || isHotfix) bump = `prerelease --predid=${isPrerelease || isHotfix}`
      const { stdout } = await execute(`pnpm version ${bump} --no-git-tag-version --allow-same-version`, { cwd: pkg.path });
      pkg.next = stdout.trim().replace(/^v/, '');
    })

    await Promise.all(promises)
  }

  async _checkImpactedPackages() {
    this.config.scan = this.config.scan.map((p: string) => path.resolve(p))
    this.pending.commits.forEach((commit) => {
      const files = commit.files.filter((file) => this.config.scan.some((p: string) => file.startsWith(p)))
      if (!files.length && this.config.rootPackage) this.addPackage(".", commit)
      else if (files.length) {
        let dirname = `${path.resolve('.')}/`
        files.forEach((file) => {
          let fromScan = this.config.scan.find((p: string) => file.startsWith(p)) as string
          let packagePath = file.replace(`${fromScan}/`, '')
          let path = `${fromScan.replace(dirname, '')}/${packagePath.split('/')[0]}`
          this.addPackage(path, commit)
        })
      }
    })
  }

  _getPackageByPath(path: string) {
    return Object.values(this.pending.packages).find((r) => r.path === path)
  }

  addPackage(path: string, commit: Commit) {
    if (! this._getPackageByPath(path)) {
      let json = readJson(`${path}/package.json`)
      this.pending.packages[json.name] =  {
        commits: [],
        path,
        json,
        name: json.name,
        bump: false,
        changelog: '',
        current: json.version,
        next: json.version,
        dependencies: []
      }
    }
    let pkg = this._getPackageByPath(path)
    if (!pkg) return log(`Package not found: ${path}??`)
    pkg.commits.push(commit)
    pkg.bump = this.getBump(commit.type, pkg.bump)
  }

  getBump(type: string, current: Bump) {
    if (type === 'major') return 'major'
    if (type === 'feat' && current != 'major') return 'minor'
    if (type === 'fix' && current === false) return 'patch'
    return current
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
    const targetBranch = await execute(`git fetch origin ${this.options.target} 2> /dev/null || echo false`).then((x) => x.stdout.trim());
    if (targetBranch === 'false') {
      log(`Branch ${this.target} does not exist, creating it...`);
      await execute(`git checkout -b ${this.options.target} origin/${this.options.base || this.config.baseTarget}`);
      await execute(`git push origin ${this.options.target}`);
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
