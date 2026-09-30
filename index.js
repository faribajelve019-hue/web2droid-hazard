const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const app = express();

const PORT = Number(process.env.PORT || 8080);

const BASE_DIR = "/tmp/web2droid";
const JOBS_DIR = path.join(BASE_DIR, "jobs");
const BUILDS_DIR = path.join(BASE_DIR, "builds");
const PROJECTS_DIR = path.join(BASE_DIR, "projects");

const ANDROID_HOME =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  "/opt/android-sdk";

const GRADLE_BIN =
  process.env.GRADLE_BIN ||
  "/opt/gradle-8.7/bin/gradle";

const BUILD_TIMEOUT = 10 * 60 * 1000;

fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(BUILDS_DIR, { recursive: true });
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

app.use(express.json({ limit: "10mb" }));

function now() {
  return new Date().toISOString();
}

function jobPath(id) {
  return path.join(JOBS_DIR, `${id}.json`);
}

function loadJob(id) {
  try {
    return JSON.parse(
      fs.readFileSync(jobPath(id), "utf8")
    );
  } catch {
    return null;
  }
}

function saveJob(job) {
  fs.writeFileSync(
    jobPath(job.id),
    JSON.stringify(job, null, 2)
  );
}

function updateJob(job, changes) {
  Object.assign(job, changes);
  saveJob(job);
}

function addLog(job, message) {
  job.logs = job.logs || [];
  job.logs.push(`[${now()}] ${message}`);

  if (job.logs.length > 100) {
    job.logs = job.logs.slice(-100);
  }

  saveJob(job);
}

function makeJobId() {
  return (
    "job_" +
    Date.now() +
    "_" +
    crypto.randomBytes(6).toString("hex")
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

function validPackageName(value) {
  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(
    value
  );
}

function safeAppName(value) {
  return String(value || "Web App")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .trim()
    .slice(0, 60) || "Web App";
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
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: {
          ...process.env,

          ANDROID_HOME,
          ANDROID_SDK_ROOT: ANDROID_HOME,

          PATH:
            `${ANDROID_HOME}/platform-tools:` +
            `${ANDROID_HOME}/cmdline-tools/latest/bin:` +
            `/opt/gradle-8.7/bin:` +
            (process.env.PATH || "")
        },

        maxBuffer: 20 * 1024 * 1024
      },

      (error, stdout, stderr) => {
        if (error) {
          const e = new Error(
            `${command} ${args.join(" ")} failed\n` +
            `${stderr || stdout || error.message}`
          );

          e.stdout = stdout;
          e.stderr = stderr;

          reject(e);
          return;
        }

        resolve({
          stdout,
          stderr
        });
      }
    );
  });
}

function writeFile(file, content) {
  fs.mkdirSync(
    path.dirname(file),
    { recursive: true }
  );

  fs.writeFileSync(
    file,
    content
  );
}

async function buildJob(jobId) {
  const job = loadJob(jobId);

  if (!job) {
    console.error(
      "JOB NOT FOUND:",
      jobId
    );
    return;
  }

  if (job.status === "completed") {
    return;
  }

  let projectDir = null;

  try {
    updateJob(job, {
      status: "building",
      progress: 5,
      startedAt: now(),
      error: null
    });

    addLog(
      job,
      "Build worker started"
    );

    addLog(
      job,
      `ANDROID_HOME=${ANDROID_HOME}`
    );

    addLog(
      job,
      `GRADLE_BIN=${GRADLE_BIN}`
    );

    projectDir = path.join(
      PROJECTS_DIR,
      job.id
    );

    fs.rmSync(
      projectDir,
      {
        recursive: true,
        force: true
      }
    );

    fs.mkdirSync(
      projectDir,
      {
        recursive: true
      }
    );

    addLog(
      job,
      "Creating Android project"
    );

    updateJob(job, {
      progress: 10
    });

    const settingsGradle = `
pluginManagement {
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

rootProject.name = "Web2DroidApp"
include(":app")
`;

    const rootBuildGradle = `
plugins {
    id 'com.android.application' version '8.5.2' apply false
}
`;

    const gradleProperties = `
org.gradle.jvmargs=-Xmx1536m
android.useAndroidX=true
android.nonTransitiveRClass=true
`;

    const appBuildGradle = `
plugins {
    id 'com.android.application'
}

android {
    namespace '${job.packageName}'
    compileSdk 35

    defaultConfig {
        applicationId '${job.packageName}'
        minSdk 23
        targetSdk 35
        versionCode 1
        versionName "1.0"
    }
}

dependencies {
    implementation 'androidx.appcompat:appcompat:1.7.0'
}
`;

    const manifest = `
<?xml version="1.0" encoding="utf-8"?>
<manifest
    xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission
        android:name="android.permission.INTERNET" />

    <application
        android:allowBackup="true"
        android:usesCleartextTraffic="true"
        android:label="${xmlEscape(job.appName)}"
        android:theme="@style/AppTheme">

        <activity
            android:name=".MainActivity"
            android:exported="true">

            <intent-filter>
                <action
                    android:name="android.intent.action.MAIN" />

                <category
                    android:name="android.intent.category.LAUNCHER" />

            </intent-filter>

        </activity>

    </application>

</manifest>
`;

    const styles = `
<?xml version="1.0" encoding="utf-8"?>
<resources>

    <style
        name="AppTheme"
        parent="android:style/Theme.Material.Light.NoActionBar">

        <item name="android:fontFamily">sans</item>
        <item name="android:colorAccent">#8B5CF6</item>
        <item name="android:navigationBarColor">#000000</item>
        <item name="android:statusBarColor">#000000</item>

    </style>

</resources>
`;

    const java = `
package ${job.packageName};

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);

        webView.setWebViewClient(
            new WebViewClient()
        );

        WebSettings settings =
            webView.getSettings();

        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);

        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);

        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);

        webView.loadUrl(
            "${javaEscape(job.url)}"
        );

        setContentView(webView);
    }

    @Override
    public void onBackPressed() {

        if (
            webView != null &&
            webView.canGoBack()
        ) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
`;

    writeFile(
      path.join(
        projectDir,
        "settings.gradle"
      ),
      settingsGradle
    );

    writeFile(
      path.join(
        projectDir,
        "build.gradle"
      ),
      rootBuildGradle
    );

    writeFile(
      path.join(
        projectDir,
        "gradle.properties"
      ),
      gradleProperties
    );

    writeFile(
      path.join(
        projectDir,
        "app",
        "build.gradle"
      ),
      appBuildGradle
    );

    writeFile(
      path.join(
        projectDir,
        "app",
        "src",
        "main",
        "AndroidManifest.xml"
      ),
      manifest
    );

    writeFile(
      path.join(
        projectDir,
        "app",
        "src",
        "main",
        "res",
        "values",
        "styles.xml"
      ),
      styles
    );

    writeFile(
      path.join(
        projectDir,
        "app",
        "src",
        "main",
        "java",
        ...job.packageName.split("."),
        "MainActivity.java"
      ),
      java
    );

    addLog(
      job,
      "Android project created"
    );

    updateJob(job, {
      progress: 20
    });

    addLog(
      job,
      "Checking Java"
    );

    try {
      const result = await runCommand(
        "java",
        ["-version"],
        {
          cwd: projectDir
        }
      );

      addLog(
        job,
        "Java is available"
      );

      if (result.stderr) {
        addLog(
          job,
          result.stderr
            .trim()
            .split("\n")[0]
        );
      }

    } catch (e) {
      throw new Error(
        "Java is not available: " +
        e.message
      );
    }

    updateJob(job, {
      progress: 30
    });

    addLog(
      job,
      "Checking Gradle"
    );

    try {

      await runCommand(
        GRADLE_BIN,
        ["--version"],
        {
          cwd: projectDir
        }
      );

      addLog(
        job,
        "Gradle is available"
      );

    } catch (e) {

      throw new Error(
        "Gradle is not available: " +
        e.message
      );

    }

    updateJob(job, {
      progress: 40
    });

    addLog(
      job,
      "Running Gradle assembleRelease"
    );

    const buildPromise =
      runCommand(
        GRADLE_BIN,
        [
          "assembleRelease",
          "--no-daemon",
          "--stacktrace"
        ],
        {
          cwd: projectDir
        }
      );

    const timeoutPromise =
      new Promise(
        (_, reject) => {

          setTimeout(
            () => {
              reject(
                new Error(
                  "Build timeout after 10 minutes"
                )
              );
            },
            BUILD_TIMEOUT
          );

        }
      );

    const result =
      await Promise.race([
        buildPromise,
        timeoutPromise
      ]);

    if (result.stdout) {

      const lines =
        result.stdout
          .split("\n")
          .filter(Boolean)
          .slice(-30);

      for (const line of lines) {
        addLog(
          job,
          line
        );
      }
    }

    updateJob(job, {
      progress: 80
    });

    const apkPath =
      path.join(
        projectDir,
        "app",
        "build",
        "outputs",
        "apk",
        "release",
        "app-release.apk"
      );

    if (!fs.existsSync(apkPath)) {
      throw new Error(
        "APK was not generated: " +
        apkPath
      );
    }

    addLog(
      job,
      "APK generated successfully"
    );

    const outputName =
      `${job.packageName}-${job.id}.apk`;

    const outputPath =
      path.join(
        BUILDS_DIR,
        outputName
      );

    fs.copyFileSync(
      apkPath,
      outputPath
    );

    const size =
      fs.statSync(outputPath).size;

    addLog(
      job,
      `APK size: ${size} bytes`
    );

    updateJob(job, {
      status: "completed",
      progress: 100,
      completedAt: now(),
      downloadUrl:
        `/api/v1/download/${job.id}`,
      apkPath: outputPath
    });

    addLog(
      job,
      "Build completed successfully"
    );

  } catch (error) {

    console.error(
      "BUILD ERROR:",
      jobId,
      error
    );

    const currentJob =
      loadJob(jobId);

    if (currentJob) {

      updateJob(
        currentJob,
        {
          status: "failed",
          progress: 0,
          completedAt: now(),
          error: error.message
        }
      );

      addLog(
        currentJob,
        "BUILD FAILED"
      );

      if (error.stdout) {
        addLog(
          currentJob,
          error.stdout.slice(-5000)
        );
      }

      if (error.stderr) {
        addLog(
          currentJob,
          error.stderr.slice(-5000)
        );
      }
    }
  }
}

let workerRunning = false;

async function processQueue() {

  if (workerRunning) {
    return;
  }

  workerRunning = true;

  try {

    const files =
      fs.readdirSync(JOBS_DIR)
        .filter(
          file =>
            file.endsWith(".json")
        );

    for (const file of files) {

      const id =
        path.basename(
          file,
          ".json"
        );

      const job =
        loadJob(id);

      if (!job) {
        continue;
      }

      if (
        job.status === "queued" ||
        job.status === "building"
      ) {

        console.log(
          "WORKER PICKED JOB:",
          id
        );

        await buildJob(id);

        break;
      }
    }

  } catch (error) {

    console.error(
      "QUEUE ERROR:",
      error
    );

  } finally {

    workerRunning = false;
  }
}

app.get(
  "/",
  (req, res) => {

    res.json({
      name:
        "Hazard Studio Web2Droid",

      version:
        "2.0.0",

      status:
        "online",

      service:
        "Web URL to APK",

      endpoints: {
        health:
          "GET /health",

        generate:
          "POST /api/v1/generate-apk",

        job:
          "GET /api/v1/job/:id",

        download:
          "GET /api/v1/download/:id"
      }
    });

  }
);

app.get(
  "/health",
  (req, res) => {

    res.json({
      status:
        "ok",

      service:
        "web2droid",

      worker:
        workerRunning,

      androidHome:
        ANDROID_HOME,

      gradle:
        GRADLE_BIN,

      time:
        now()
    });

  }
);

app.post(
  "/api/v1/generate-apk",
  (req, res) => {

    try {

      const {
        url,
        packageName,
        options = {}
      } = req.body || {};

      if (!url) {

        return res.status(400).json({
          success: false,
          error:
            "url is required"
        });

      }

      if (!validUrl(url)) {

        return res.status(400).json({
          success: false,
          error:
            "URL must start with http:// or https://"
        });

      }

      if (!packageName) {

        return res.status(400).json({
          success: false,
          error:
            "packageName is required"
        });

      }

      if (!validPackageName(packageName)) {

        return res.status(400).json({
          success: false,
          error:
            "Invalid Android package name"
        });

      }

      const appName =
        safeAppName(
          options.appName ||
          options.name ||
          "Web App"
        );

      const id =
        makeJobId();

      const job = {

        id,

        url,

        packageName,

        appName,

        status:
          "queued",

        progress:
          0,

        createdAt:
          now(),

        startedAt:
          null,

        completedAt:
          null,

        downloadUrl:
          null,

        apkPath:
          null,

        error:
          null,

        logs: [
          "Job created"
        ]
      };

      saveJob(job);

      console.log(
        "NEW JOB:",
        id
      );

      Promise.resolve()
        .then(
          () => buildJob(id)
        )
        .catch(
          error => {
            console.error(
              "Detached worker error:",
              error
            );
          }
        );

      return res
        .status(202)
        .json({

          success:
            true,

          jobId:
            id,

          status:
            "queued",

          statusUrl:
            `/api/v1/job/${id}`,

          message:
            "APK build started"
        });

    } catch (error) {

      console.error(
        "GENERATE ERROR:",
        error
      );

      return res.status(500).json({
        success:
          false,

        error:
          error.message
      });

    }

  }
);

app.get(
  "/api/v1/job/:id",
  (req, res) => {

    const job =
      loadJob(
        req.params.id
      );

    if (!job) {

      return res.status(404).json({
        success:
          false,

        error:
          "Job not found"
      });

    }

    res.json({

      id:
        job.id,

      url:
        job.url,

      packageName:
        job.packageName,

      appName:
        job.appName,

      status:
        job.status,

      progress:
        job.progress,

      createdAt:
        job.createdAt,

      startedAt:
        job.startedAt,

      completedAt:
        job.completedAt,

      downloadUrl:
        job.downloadUrl,

      error:
        job.error,

      logs:
        job.logs || []
    });

  }
);

app.get(
  "/api/v1/download/:id",
  (req, res) => {

    const job =
      loadJob(
        req.params.id
      );

    if (!job) {

      return res.status(404).json({
        success:
          false,

        error:
          "Job not found"
      });

    }

    if (
      job.status !==
      "completed"
    ) {

      return res.status(409).json({

        success:
          false,

        error:
          "APK is not ready",

        status:
          job.status,

        progress:
          job.progress
      });

    }

    if (
      !job.apkPath ||
      !fs.existsSync(
        job.apkPath
      )
    ) {

      return res.status(404).json({
        success:
          false,

        error:
          "APK file not found"
      });

    }

    res.download(
      job.apkPath,
      `${job.appName}.apk`
    );

  }
);

app.use(
  (err, req, res, next) => {

    console.error(
      "EXPRESS ERROR:",
      err
    );

    res.status(500).json({
      success:
        false,

      error:
        "Internal server error"
    });

  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "================================"
    );

    console.log(
      "🚀 Hazard Studio Web2Droid"
    );

    console.log(
      `🌐 Port: ${PORT}`
    );

    console.log(
      `🤖 Android SDK: ${ANDROID_HOME}`
    );

    console.log(
      `⚙️ Gradle: ${GRADLE_BIN}`
    );

    console.log(
      "================================"
    );

    setInterval(
      processQueue,
      3000
    );

    setTimeout(
      processQueue,
      1000
    );
  }
);
