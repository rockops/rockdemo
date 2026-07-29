# rockDemo "ubuntu" image — mimics Killercoda's Ubuntu environment by
# pre-installing the tooling those scenarios assume is present.
#
# Published to GHCR by .github/workflows/docker-image.yml as
# ghcr.io/rockops/rockdemo/ubuntu:24.04 (the imageid used in config/backends.json).
#
# Build locally (tag must match that imageid):
#   docker build -t ghcr.io/rockops/rockdemo/ubuntu:24.04 docker/ubuntu
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# ca-certificates so curl/wget can talk HTTPS; telnet is a transitional package
# that pulls the inetutils client on 24.04.
RUN touch /etc/modules \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      wget \
      telnet \
      docker.io \
      podman \
      kmod \
      sudo \
      vim \
      nano \
      tree \
      make \
      iputils-ping \
      git \
      python3 \
      python3-pip \
      python-is-python3 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /root

CMD ["bash"]
