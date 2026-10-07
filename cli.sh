#!/bin/bash

echo "Running..."
npx tsc && node dist/cli/cli.js

if [ $? -ne 0 ]; then
    echo "Failed!"
    read -p "Press [Enter] key to continue..."
else
    echo "Ran Successfully..."
    read -p "Press [Enter] key to continue..."
fi
