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
   * @param {string} [options.workspace] - Host workspace path to mount
   */
  constructor(options = {}) {
    this.docker = new Dockerode({
      socketPath: options.socketPath || '/var/run/docker.sock',
    });
    this.defaultImage = options.image || 'ubuntu:22.04';
    this.workspace = options.workspace || process.cwd();
    this.container = null;
    this._containerId = null;
  }

  /**
   * Pull an image if not already available locally.
   *
   * @param {string} image - Docker image name
   * @param {object} [options]
   * @param {function} [options.onProgress] - Progress callback ({ status, progress, id })
   */
  async pullImage(image, options = {}) {
    const images = await this.docker.listImages({
      filters: { reference: [image] },
    });

    if (images.length > 0) return;

    await new Promise((resolve, reject) => {
      this.docker.pull(image, (err, stream) => {
        if (err) return reject(err);
        this.docker.modem.followProgress(
          stream,
          (err) => {
            if (err) reject(err);
            else resolve();
          },
          (event) => {
            if (options.onProgress) {
              options.onProgress({
                status: event.status || '',
                progress: event.progress || '',
                id: event.id || '',
              });
            }
          }
        );
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
    await this.pullImage(image, { onProgress: options.onProgress });

    const envArray = options.env
      ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`)
      : [];

    const workdir = options.workdir || '/github/workspace';

    // Default bind: mount host workspace into container
    const binds = options.binds || [`${this.workspace}:${workdir}`];

    this.container = await this.docker.createContainer({
      Image: image,
      Cmd: ['sleep', 'infinity'],
      Env: envArray,
      WorkingDir: workdir,
      Tty: false,
      OpenStdin: true,
      HostConfig: {
        Binds: binds,
      },
      Labels: {
        'actionlens': 'true',
      },
    });

    this._containerId = this.container.id;
    await this.container.start();
    return this.container;
  }

  /**
   * Execute a command inside the running container, capturing stdout/stderr.
   *
   * @param {string|string[]} command - Command to execute
   * @param {object} [options]
   * @param {string} [options.workdir] - Working directory for this exec
   * @param {object} [options.env] - Additional environment variables
   * @param {number} [options.timeout] - Timeout in milliseconds
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
      WorkingDir: options.workdir || undefined,
      Env: envArray.length > 0 ? envArray : undefined,
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    const outputPromise = collectOutput(stream);

    // Apply timeout if specified
    let result;
    if (options.timeout && options.timeout > 0) {
      result = await withTimeout(outputPromise, options.timeout, () => {
        stream.destroy();
      });
    } else {
      result = await outputPromise;
    }

    const inspect = await exec.inspect();
    const exitCode = inspect.ExitCode;

    return { exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  /**
   * Execute a command with real-time output streaming.
   *
   * @param {string|string[]} command - Command to execute
   * @param {object} [options]
   * @param {string} [options.workdir] - Working directory for this exec
   * @param {object} [options.env] - Additional environment variables
   * @param {function} [options.onStdout] - Called with each stdout chunk
   * @param {function} [options.onStderr] - Called with each stderr chunk
   * @param {number} [options.timeout] - Timeout in milliseconds
   * @returns {{ exitCode: number, stdout: string, stderr: string }}
   */
  async execStream(command, options = {}) {
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
      WorkingDir: options.workdir || undefined,
      Env: envArray.length > 0 ? envArray : undefined,
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    const outputPromise = streamOutput(stream, options.onStdout, options.onStderr);

    let result;
    if (options.timeout && options.timeout > 0) {
      result = await withTimeout(outputPromise, options.timeout, () => {
        stream.destroy();
      });
    } else {
      result = await outputPromise;
    }

    const inspect = await exec.inspect();
    const exitCode = inspect.ExitCode;

    return { exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  /**
   * Spawn an interactive bash shell inside the container.
   * Returns the container ID so TUI can attach via `docker exec -it`.
   *
   * @returns {{ containerId: string, cmd: string[] }}
   */
  shellInContainer() {
    if (!this.container) {
      throw new Error('No container running. Call createContainer() first.');
    }
    return {
      containerId: this._containerId,
      cmd: ['docker', 'exec', '-it', this._containerId, 'bash'],
    };
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
    this._containerId = null;
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
 * Apply a timeout to a promise. On timeout, call cleanup and reject.
 */
function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (onTimeout) onTimeout();
      reject(new Error(`Command timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
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
    stream.on('error', () => resolve({ stdout, stderr }));
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

/**
 * Stream stdout/stderr from a Docker exec stream, calling callbacks in real-time.
 * Also collects full output for the return value.
 */
function streamOutput(stream, onStdout, onStderr) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    stream.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;

      while (offset < buffer.length) {
        if (offset + 8 > buffer.length) break;

        const type = buffer.readUInt8(offset);
        const size = buffer.readUInt32BE(offset + 4);

        if (offset + 8 + size > buffer.length) break;

        const payload = buffer.slice(offset + 8, offset + 8 + size).toString('utf-8');

        if (type === 1) {
          stdout += payload;
          if (onStdout) onStdout(payload);
        } else if (type === 2) {
          stderr += payload;
          if (onStderr) onStderr(payload);
        }

        offset += 8 + size;
      }
    });

    stream.on('error', () => resolve({ stdout, stderr }));
    stream.on('end', () => resolve({ stdout, stderr }));
  });
}
