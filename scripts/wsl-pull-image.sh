#!/bin/bash
# Pull the dotd exec base image (design §9.5) ahead of time — fleet build starts FROM this.
docker pull mcr.microsoft.com/playwright:v1.49.1-noble && echo PULL_DONE || echo PULL_FAIL
