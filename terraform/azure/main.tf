/**
 * Terraform configuration and Azure provider setup.
 * Azure Blob Storage backend stores state in resources you must create manually
 * during Phase 4 before first init:
 *   az group create --name tomoribot-tfstate-rg --location japanwest
 *   az storage account create --resource-group tomoribot-tfstate-rg --name <globally-unique-name> --sku Standard_LRS
 *   az storage container create --account-name <globally-unique-name> --name tfstate
 *
 * Backend config cannot use variables. Override the placeholder storage account
 * after bootstrap with:
 *   terraform init -backend-config="storage_account_name=<globally-unique-name>"
 * Additional overrides are available for resource_group_name, container_name,
 * and key if Phase 4 chooses different state resource names.
 */

terraform {
  required_version = "~> 1.14.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "4.81.0"
    }
  }

  backend "azurerm" {
    resource_group_name  = "tomoribot-tfstate-rg"
    storage_account_name = "tomoribottfstate"
    container_name       = "tfstate"
    key                  = "production.tfstate"
  }
}

provider "azurerm" {
  subscription_id = var.azure_subscription_id

  features {}
}

locals {
  common_tags = {
    Project     = "TomoriBot"
    ManagedBy   = "Terraform"
    Environment = var.environment
  }
}

resource "azurerm_resource_group" "main" {
  name     = var.resource_group_name
  location = var.azure_location
  tags     = local.common_tags

  # Deleting a resource group deletes everything inside it, including the PostgreSQL server and its
  # backups, so this is the widest blast radius in the configuration and the cheapest one to guard.
  lifecycle {
    prevent_destroy = true
  }
}
