import Dockerode from 'dockerode';

/**
 * Manages Docker container lifecycle for running workflow steps.
 * Wraps dockerode to provide a high-level API for creating, executing in,
 * and cleaning up containers.
 */
export class DockerRunner {
  /**
   * @param {object} [options]
   * @param {string} [options.socketPath] - Docker socket path
   * @param {string} [options.image] - Default container image
   */
  constructor(options = {}) {
    this.docker = new Dockerode({
      socketPath: options.socketPath || '/var/run/docker.sock',
    });
    this.defaultImage = options.image || 'ubuntu:22.04';
    this.container = null;
  }

  /**
   * Pull an image if not already available locally.
   *
   * @param {string} image - Docker image name
   */
  async pullImage(image) {
    const images = await this.docker.listImages({
      filters: { reference: [image] },
    });

    if (images.length > 0) return;

    await new Promise((resolve, reject) => {
      this.docker.pull(image, (err, stream) => {
        if (err) return reject(err);
        this.docker.modem.followProgress(stream, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  /**
   * Create and start a container for running workflow steps.
   *
   * @param {object} options
   * @param {string} [options.image] - Docker image
   * @param {object} [options.env] - Environment variables as key-value pairs
   * @param {string} [options.workdir] - Working directory inside container
   * @param {string[]} [options.binds] - Volume binds (host:container format)
   * @returns {object} Container instance
   */
  async createContainer(options = {}) {
    const image = options.image || this.defaultImage;
    await this.pullImage(image);

    const envArray = options.env
      ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`)
      : [];

    this.container = await this.docker.createContainer({
      Image: image,
      Cmd: ['sleep', 'infinity'], // Keep container alive for step execution
      Env: envArray,
      WorkingDir: options.workdir || '/github/workspace',
      Tty: true,
      HostConfig: {
        Binds: options.binds || [],
      },
      Labels: {
        'actionlens': 'true',
      },
    });

    await this.container.start();
    return this.container;
  }

  /**
   * Execute a command inside the running container.
   *
   * @param {string|string[]} command - Command to execute
   * @param {object} [options]
   * @param {string} [options.workdir] - Working directory for this exec
   * @param {object} [options.env] - Additional environment variables
   * @returns {{ exitCode: number, stdout: string, stderr: string }}
   */
  async exec(command, options = {}) {
    if (!this.container) {
      throw new Error('No container running. Call createContainer() first.');
    }

    const cmd = Array.isArray(command) ? command : ['sh', '-e', '-c', command];

    const envArray = options.env
      ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`)
      : [];

    const exec = await this.container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      WorkingDir: options.workdir,
      Env: envArray.length > 0 ? envArray : undefined,
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    const { stdout, stderr } = await collectOutput(stream);

    const inspect = await exec.inspect();
    const exitCode = inspect.ExitCode;

    return { exitCode, stdout, stderr };
  }

  /**
   * Remove the container, forcefully if needed.
   */
  async cleanup() {
    if (!this.container) return;

    try {
      await this.container.stop({ t: 2 });
    } catch {
      // Container may already be stopped
    }

    try {
      await this.container.remove({ force: true });
    } catch {
      // Container may already be removed
    }

    this.container = null;
  }

  /**
   * Check if Docker is accessible.
   *
   * @returns {boolean}
   */
  async isAvailable() {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Collect stdout/stderr from a Docker exec stream.
 * Docker multiplexes stdout/stderr in a single stream with an 8-byte header per frame.
 */
function collectOutput(stream) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const chunks = [];

    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      const buffer = Buffer.concat(chunks);
      let offset = 0;

      while (offset < buffer.length) {
        if (offset + 8 > buffer.length) break;

        const type = buffer.readUInt8(offset);
        const size = buffer.readUInt32BE(offset + 4);

        if (offset + 8 + size > buffer.length) break;

        const payload = buffer.slice(offset + 8, offset + 8 + size).toString('utf-8');

        if (type === 1) stdout += payload;
        else if (type === 2) stderr += payload;

        offset += 8 + size;
      }

      resolve({ stdout, stderr });
    });
  });
}
