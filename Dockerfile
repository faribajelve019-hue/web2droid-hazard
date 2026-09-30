FROM eclipse-temurin:17-jdk-jammy

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    wget \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Android SDK
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk

RUN mkdir -p ${ANDROID_HOME}/cmdline-tools

RUN wget -q \
    https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
    -O /tmp/cmdline-tools.zip

RUN unzip -q \
    /tmp/cmdline-tools.zip \
    -d ${ANDROID_HOME}/cmdline-tools

RUN mv \
    ${ANDROID_HOME}/cmdline-tools/cmdline-tools \
    ${ANDROID_HOME}/cmdline-tools/latest

ENV PATH=${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/cmdline-tools/latest/bin:$PATH

RUN yes | sdkmanager --licenses || true

RUN sdkmanager \
    "platform-tools" \
    "platforms;android-35" \
    "build-tools;35.0.0"

# Gradle
ENV GRADLE_VERSION=8.7

RUN wget -q \
    https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip \
    -O /tmp/gradle.zip

RUN unzip -q \
    /tmp/gradle.zip \
    -d /opt

ENV PATH=/opt/gradle-${GRADLE_VERSION}/bin:$PATH

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev

COPY index.js ./

EXPOSE 3000

CMD ["node", "index.js"]
