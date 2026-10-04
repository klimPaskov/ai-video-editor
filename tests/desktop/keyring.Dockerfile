FROM ai-video-editor-desktop:p0

USER root
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    gnome-keyring libsecret-1-0 \
    && rm -rf /var/lib/apt/lists/*
USER node
