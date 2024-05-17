#!/bin/bash

CONTAINER_ALREADY_STARTED="/firstrun/CONTAINER_ALREADY_STARTED_PLACEHOLDER"
if [ ! -e $CONTAINER_ALREADY_STARTED ]; then
    echo "-- First container startup. Let the Storage Proxy node join the logstore network --"
    logstore-storage-proxy --dev-network --private-key $STORAGE_PROXY_PRIVATE_KEY create "$STORAGE_PROXY_METADATA" &&
    logstore-storage-proxy --dev-network --private-key $STORAGE_PROXY_PRIVATE_KEY add-node $STORAGE_PROXY_NODE_ADDRESS &&
    logstore --host http://10.200.10.1:8547 --wallet $STORAGE_PROXY_NODE_PRIVATE_KEY query stake -y 1000000000000000000000000000000 --debug &&
    touch $CONTAINER_ALREADY_STARTED
else
    echo "-- Not first container startup, doing nothing.--"
fi
