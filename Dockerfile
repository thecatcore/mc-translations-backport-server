FROM denoland/deno

RUN apt-get -y update
RUN apt-get -y install git

EXPOSE 8005:8005

USER deno

COPY . /app
WORKDIR /app

CMD [ "sudo", "deno", "run", "--allow-read=./mc-translations-backport-data,./data", "--allow-run=git", "--allow-net", "--allow-write=./data", "server.ts" ]