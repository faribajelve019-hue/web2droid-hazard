const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");

const app = express();

app.use(express.json({ limit: "10mb" }));

const PORT = Number(process.env.PORT || 8080);

const ANDROID_HOME =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  "/opt/android-sdk";

const GRADLE_BIN =
  process.env.GRADLE_BIN ||
  "/opt/gradle-8.7/bin/gradle";

/*
 * /app/data is used instead of /tmp so jobs survive
 * normal application restarts.
 */
const DATA_DIR = "/app/data";
const JOBS_DIR = path.join(DATA_DIR, "jobs");
const BUILDS_DIR = path.join(DATA_DIR, "builds");
const PROJECTS_DIR = path.join(DATA_DIR, "projects");

const activeJobs = new Set();
let workerRunning = false;

const BUILD_TIMEOUT = 10 * 60 * 1000;

async function ensureDirs() {
  await fsp.mkdir(JOBS_DIR, { recursive: true });
  await fsp.mkdir(BUILDS_DIR, { recursive: true });
  await fsp.mkdir(PROJECTS_DIR, { recursive: true });
}

function now() {
  return new Date().toISOString();
}

function jobFile(id) {
  return path.join(JOBS_DIR, `${id}.json`);
}

async function saveJob(job) {
  job.updatedAt = now();

  const tmp = `${jobFile(job.id)}.tmp`;

  await fsp.writeFile(
    tmp,
    JSON.stringify(job, null, 2),
    "utf8"
  );

  await fsp.rename(tmp, jobFile(job.id));
}

async function loadJob(id) {
  try {
    const data = await fsp.readFile(jobFile(id), "utf8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function listJobs() {
  try {
    const files = await fsp.readdir(JOBS_DIR);

    const result = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      try {
        const data = await fsp.readFile(
          path.join(JOBS_DIR, file),
          "utf8"
        );

        result.push(JSON.parse(data));
      } catch {}
    }

    return result;
  } catch {
    return [];
  }
}

function addLog(job, message) {
  if (!Array.isArray(job.logs)) {
    job.logs = [];
  }

  job.logs.push(`[${now()}] ${message}`);

  // Keep logs from growing forever.
  if (job.logs.length > 500) {
    job.logs = job.logs.slice(-500);
  }
}

async function log(job, message) {
  addLog(job, message);
  await saveJob(job);
}

function createJobId() {
  return `job_${Date.now()}_${crypto
    .randomBytes(6)
    .toString("hex")}`;
}

function validPackageName(value) {
  if (typeof value !== "string") return false;

  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(
    value
  );
}

function validUrl(value) {
  try {
    const u = new URL(value);

    return (
      u.protocol === "http:" ||
      u.protocol === "https:"
    );
  } catch {
    return false;
  }
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function javaEscape(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ANDROID_HOME,
      ANDROID_SDK_ROOT: ANDROID_HOME,
      PATH:
        `${ANDROID_HOME}/platform-tools:` +
        `${ANDROID_HOME}/cmdline-tools/latest/bin:` +
        `${process.env.PATH || ""}`
    };

    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env,
        timeout: options.timeout || 120000,
        maxBuffer: 20 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }

        resolve({
          stdout: stdout || "",
          stderr: stderr || ""
        });
      }
    );
  });
}

function streamCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      ANDROID_HOME,
      ANDROID_SDK_ROOT: ANDROID_HOME,
      PATH:
        `${ANDROID_HOME}/platform-tools:` +
        `${ANDROID_HOME}/cmdline-tools/latest/bin:` +
        `${process.env.PATH || ""}`
    };

    const child = spawn(command, args, {
      cwd: options.cwd,
      env
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;

      try {
        child.kill("SIGTERM");
      } catch {}

      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 5000);

      const error = new Error(
        "Gradle build timed out after 10 minutes"
      );

      error.code = "BUILD_TIMEOUT";
      error.stdout = stdout;
      error.stderr = stderr;

      finished = true;
      reject(error);
    }, options.timeout || BUILD_TIMEOUT);

    child.stdout.on("data", chunk => {
      const text = chunk.toString();

      stdout += text;

      if (options.onOutput) {
        options.onOutput(text, false);
      }
    });

    child.stderr.on("data", chunk => {
      const text = chunk.toString();

      stderr += text;

      if (options.onOutput) {
        options.onOutput(text, true);
      }
    });

    child.on("error", error => {
      if (finished) return;

      finished = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", code => {
      if (finished) return;

      finished = true;
      clearTimeout(timeout);

      if (code !== 0) {
        const error = new Error(
          `Command exited with code ${code}`
        );

        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;

        reject(error);
        return;
      }

      resolve({
        code,
        stdout,
        stderr
      });
    });
  });
}

async function writeFile(file, content) {
  await fsp.mkdir(path.dirname(file), {
    recursive: true
  });

  await fsp.writeFile(file, content, "utf8");
}

async function createAndroidProject(job, projectDir) {
  const packageName = job.packageName;
  const appName = job.appName;
  const url = job.url;

  const packagePath = packageName.replace(/\./g, "/");

  await fsp.mkdir(projectDir, {
    recursive: true
  });

  await writeFile(
    path.join(projectDir, "settings.gradle"),
`pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "Web2Droid"
include(":app")
`
  );

  await writeFile(
    path.join(projectDir, "build.gradle"),
`plugins {
    id 'com.android.application' version '8.5.2' apply false
}
`
  );

  await writeFile(
    path.join(projectDir, "gradle.properties"),
`org.gradle.jvmargs=-Xmx1536m -Dfile.encoding=UTF-8
android.useAndroidX=true
android.nonTransitiveRClass=true
`
  );

  const appDir = path.join(projectDir, "app");

  await writeFile(
    path.join(appDir, "build.gradle"),
`plugins {
    id 'com.android.application'
}

android {
    namespace '${packageName}'
    compileSdk 35

    defaultConfig {
        applicationId '${packageName}'
        minSdk 23
        targetSdk 35
        versionCode 1
        versionName '1.0'
    }
}

dependencies {
    implementation 'androidx.appcompat:appcompat:1.7.0'
}
`
  );

  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:allowBackup="true"
        android:usesCleartextTraffic="true"
        android:label="${xmlEscape(appName)}"
        android:theme="@style/AppTheme">

        <activity
            android:name=".MainActivity"
            android:exported="true">

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>

        </activity>

    </application>

</manifest>
`;

  await writeFile(
    path.join(
      appDir,
      "src/main/AndroidManifest.xml"
    ),
    manifest
  );

  const java = `package ${packageName};

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {

    private static final String URL = "${javaEscape(url)}";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView webView = new WebView(this);

        WebSettings settings = webView.getSettings();

        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        webView.setWebViewClient(new WebViewClient());

        setContentView(webView);

        webView.loadUrl(URL);
    }

    @Override
    public void onBackPressed() {
        WebView webView =
            (WebView) findViewById(android.R.id.content)
            .getRootView()
            .findFocus();

        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
`;

  await writeFile(
    path.join(
      appDir,
      `src/main/java/${packagePath}/MainActivity.java`
    ),
    java
  );

  const styles = `<?xml version="1.0" encoding="utf-8"?>
<resources>

    <style name="AppTheme"
        parent="Theme.AppCompat.Light.NoActionBar">
        <item name="android:fontFamily">sans</item>
        <item name="android:windowActionModeOverlay">true</item>
        <item name="android:colorAccent">#6200EE</item>
    </style>

</resources>
`;

  await writeFile(
    path.join(
      appDir,
      "src/main/res/values/styles.xml"
    ),
    styles
  );
}

async function appendGradleOutput(job, text, isError) {
  const lines = String(text)
    .split(/\r?\n/)
    .map(x => x.trimEnd())
    .filter(Boolean);

  if (!lines.length) return;

  for (const line of lines.slice(-50)) {
    addLog(
      job,
      `${isError ? "[Gradle stderr] " : "[Gradle] "}${line}`
    );
  }

  await saveJob(job);
}

async function buildJob(id) {
  if (activeJobs.has(id)) {
    return;
  }

  const job = await loadJob(id);

  if (!job) {
    return;
  }

  if (
    job.status === "completed" ||
    job.status === "failed"
  ) {
    return;
  }

  activeJobs.add(id);

  try {
    job.status = "building";
    job.progress = Math.max(job.progress || 0, 5);

    if (!job.startedAt) {
      job.startedAt = now();
    }

    await log(job, "Build worker started");
    await log(job, `ANDROID_HOME=${ANDROID_HOME}`);
    await log(job, `GRADLE_BIN=${GRADLE_BIN}`);

    const projectDir = path.join(
      PROJECTS_DIR,
      id
    );

    await log(job, "Creating Android project");

    await fsp.rm(projectDir, {
      recursive: true,
      force: true
    });

    await createAndroidProject(
      job,
      projectDir
    );

    job.progress = 20;

    await log(job, "Android project created");
    await log(job, "Checking Java");

    const java = await runCommand(
      "java",
      ["-version"]
    ).catch(error => {
      throw new Error(
        `Java check failed: ${error.message}\n${error.stderr || ""}`
      );
    });

    await log(job, "Java is available");

    const javaVersion =
      java.stderr || java.stdout || "";

    for (
      const line of javaVersion
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, 5)
    ) {
      await log(job, line);
    }

    await log(job, "Checking Gradle");

    await runCommand(
      GRADLE_BIN,
      ["--version"],
      {
        timeout: 120000
      }
    );

    await log(job, "Gradle is available");

    job.progress = 40;
    await saveJob(job);

    await log(
      job,
      "Running Gradle assembleRelease"
    );

    await streamCommand(
      GRADLE_BIN,
      [
        "assembleRelease",
        "--no-daemon",
        "--stacktrace",
        "--console=plain"
      ],
      {
        cwd: projectDir,
        timeout: BUILD_TIMEOUT,
        onOutput: (text, isError) => {
          appendGradleOutput(
            job,
            text,
            isError
          ).catch(() => {});
        }
      }
    );

    job.progress = 85;

    await log(
      job,
      "Gradle assembleRelease completed"
    );

    const apkSource = path.join(
      projectDir,
      "app/build/outputs/apk/release/app-release.apk"
    );

    try {
      await fsp.access(apkSource);
    } catch {
      throw new Error(
        "Gradle completed but APK file was not found"
      );
    }

    const apkName =
      `${job.id}.apk`;

    const apkDestination =
      path.join(
        BUILDS_DIR,
        apkName
      );

    await fsp.copyFile(
      apkSource,
      apkDestination
    );

    job.progress = 100;
    job.status = "completed";
    job.completedAt = now();
    job.downloadUrl =
      `/api/v1/download/${job.id}`;

    await log(job, "APK created successfully");
    await log(
      job,
      `APK path: ${apkDestination}`
    );

    await saveJob(job);

  } catch (error) {
    console.error(
      `Build failed for ${id}:`,
      error
    );

    job.status = "failed";

    job.error =
      error.message ||
      String(error);

    await log(
      job,
      `BUILD FAILED: ${job.error}`
    );

    if (error.stdout) {
      await appendGradleOutput(
        job,
        error.stdout,
        false
      );
    }

    if (error.stderr) {
      await appendGradleOutput(
        job,
        error.stderr,
        true
      );
    }

    job.completedAt = now();

    await saveJob(job);

  } finally {
    activeJobs.delete(id);
  }
}

async function processQueue() {
  if (workerRunning) {
    return;
  }

  workerRunning = true;

  try {
    const jobs = await listJobs();

    for (const job of jobs) {
      if (
        job.status === "queued" &&
        !activeJobs.has(job.id)
      ) {
        /*
         * Do NOT await the build here.
         * Start exactly one build and immediately
         * continue checking the queue.
         */
        buildJob(job.id).catch(error => {
          console.error(
            "Queue build error:",
            error
          );
        });
      }
    }
  } finally {
    workerRunning = false;
  }
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "web2droid",
    message: "Web2Droid APK Builder",
    endpoints: {
      health: "/health",
      generate: "POST /api/v1/generate-apk",
      job: "GET /api/v1/job/:id",
      download: "GET /api/v1/download/:id"
    }
  });
});

app.get("/health", async (req, res) => {
  let java = false;
  let gradle = false;

  try {
    await runCommand(
      "java",
      ["-version"],
      { timeout: 10000 }
    );

    java = true;
  } catch {}

  try {
    await runCommand(
      GRADLE_BIN,
      ["--version"],
      { timeout: 10000 }
    );

    gradle = true;
  } catch {}

  res.json({
    status: "ok",
    service: "web2droid",
    worker: workerRunning,
    activeBuilds: activeJobs.size,
    java,
    gradleAvailable: gradle,
    androidHome: ANDROID_HOME,
    gradle: GRADLE_BIN,
    time: now()
  });
});

app.post(
  "/api/v1/generate-apk",
  async (req, res) => {
    try {
      const {
        url,
        packageName,
        options = {}
      } = req.body || {};

      if (!url) {
        return res.status(400).json({
          success: false,
          error: "url is required"
        });
      }

      if (!validUrl(url)) {
        return res.status(400).json({
          success: false,
          error: "Invalid URL"
        });
      }

      if (!packageName) {
        return res.status(400).json({
          success: false,
          error: "packageName is required"
        });
      }

      if (!validPackageName(packageName)) {
        return res.status(400).json({
          success: false,
          error:
            "Invalid packageName. Example: com.example.myapp"
        });
      }

      const appName =
        String(
          options.appName ||
          "Web2Droid App"
        ).slice(0, 80);

      const id = createJobId();

      const job = {
        id,
        url,
        packageName,
        appName,
        status: "queued",
        progress: 0,
        createdAt: now(),
        startedAt: null,
        completedAt: null,
        downloadUrl: null,
        error: null,
        logs: ["Job created"]
      };

      await saveJob(job);

      /*
       * IMPORTANT:
       * There is only one execution path.
       * We don't also call setImmediate().
       */
      buildJob(id).catch(error => {
        console.error(
          "Direct build error:",
          error
        );
      });

      res.status(202).json({
        success: true,
        jobId: id,
        status: "queued",
        statusUrl:
          `/api/v1/job/${id}`,
        message:
          "APK build started"
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

app.get(
  "/api/v1/job/:id",
  async (req, res) => {
    const job =
      await loadJob(req.params.id);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found"
      });
    }

    res.json(job);
  }
);

app.get(
  "/api/v1/download/:id",
  async (req, res) => {
    const job =
      await loadJob(req.params.id);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found"
      });
    }

    if (job.status !== "completed") {
      return res.status(409).json({
        success: false,
        error:
          "APK is not ready",
        status: job.status
      });
    }

    const apk =
      path.join(
        BUILDS_DIR,
        `${job.id}.apk`
      );

    try {
      await fsp.access(apk);
    } catch {
      return res.status(404).json({
        success: false,
        error: "APK file not found"
      });
    }

    res.download(
      apk,
      `${job.appName || "Web2Droid"}.apk`
    );
  }
);

async function recoverJobs() {
  const jobs = await listJobs();

  for (const job of jobs) {
    /*
     * A process restart can leave a job marked
     * "building". Put it back into the queue.
     */
    if (job.status === "building") {
      job.status = "queued";
      job.progress = 0;
      job.error = null;

      addLog(
        job,
        "Previous build process ended; job requeued"
      );

      await saveJob(job);
    }
  }
}

async function start() {
  await ensureDirs();

  await recoverJobs();

  setInterval(() => {
    processQueue().catch(error => {
      console.error(
        "Queue worker error:",
        error
      );
    });
  }, 3000);

  await processQueue();

  app.listen(PORT, () => {
    console.log(
      `🚀 Web2Droid running on port ${PORT}`
    );

    console.log(
      `📱 ANDROID_HOME=${ANDROID_HOME}`
    );

    console.log(
      `⚙️ GRADLE_BIN=${GRADLE_BIN}`
    );

    console.log(
      "🔥 Build worker ready"
    );
  });
}

start().catch(error => {
  console.error(
    "Fatal startup error:",
    error
  );

  process.exit(1);
});

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "Unhandled rejection:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "Uncaught exception:",
      error
    );
  }
);
