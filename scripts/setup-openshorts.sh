#!/bin/bash
# Clone OpenShorts into services/openshorts/
if [ ! -d "services/openshorts/.git" ]; then
  git clone https://github.com/mutonby/openshorts.git services/openshorts
  echo "OpenShorts cloned successfully"
else
  echo "OpenShorts already cloned"
fi
