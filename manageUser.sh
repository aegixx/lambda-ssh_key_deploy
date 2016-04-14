#!/bin/bash

display_usage() {
    echo -e "\nUSAGE: manageUser ACTION USERNAME"
    echo -e "(must be run with super-user privileges)\n"
}

if [ $# -lt 2 ]; then
    display_usage
    exit 1
fi

if [[ ( $# == "--help") ||  $# == "-h" ]]; then
    display_usage
    exit 0
fi

if [[ $USER != "root" ]]; then
    echo "This script must be run as root!"
    exit 1
fi

action=$1
username=$2

if [[ "$username" == "ec2-user" || "$username" == "root" ]]; then
    echo "!! Cannot take action on ec2-user or root users !!"
    exit 1
fi

if grep -q "wheel.*$username" /etc/group; then
    echo "!! Cannot take action on members of the wheel group !!"
    exit 1
fi

if [[ "$action" != "delete" && "$action" != "add" ]]; then
    echo "Invalid action specified - Must be 'add' or 'delete'"
    exit 2
fi

if [ -z "$username" ]; then
    echo "USERNAME is required"
    exit 2
fi

# ADD
if [[ "$action" == "add" ]]; then

    read -p "Enter the public key of $username > " publickey

    if [ -z "$publickey" ]; then
        echo "A public key is required"
        exit 2
    fi

    ## Add User
    adduser -m $username

    ## Verify home folder
    mkdir -p /home/$username/.ssh

    ## Add / Reset authorized key
    echo "$publickey" > /home/$username/.ssh/authorized_keys

    ## Verify permissions
    chown -R $username:$username /home/$username
    chmod 0700 /home/$username/.ssh
    chmod 0600 /home/$username/.ssh/authorized_keys

    ## Add to admin group (if it exists)
    if grep -q admin /etc/group; then
        usermod -a -G admin $username
    fi

    exit 0

# DELETE
elif [[ "$action" == "delete" ]]; then

    ## Remove user
    userdel -r $username

    ## Delete home folder
    rm -rf /home/$username

    exit 0

else
    echo "Unrecognized action: $action"
    exit 2
fi