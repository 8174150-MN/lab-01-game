// This view keeps loading failures outside the game simulation.
export function showError(root: HTMLElement, message: string, onRetry: () => void): void {
  root.replaceChildren(); // Remove controls from any previous failure.
  const heading = document.createElement('h2'); // Give assistive technology a clear error heading.
  heading.textContent = 'Не вдалося завантажити гру'; // Use textContent so messages cannot become HTML.
  const detail = document.createElement('p'); // Create a separate explanation for the player.
  detail.textContent = message; // Display the readable error returned by main.js.
  const retry = document.createElement('button'); // Create one explicit recovery action.
  retry.type = 'button'; // Keep the button from submitting any surrounding form.
  retry.textContent = 'Повторити'; // Name the action in the player's language.
  retry.addEventListener(
    'click',
    () => {
      root.hidden = true;
      onRetry();
    },
    { once: true },
  ); // Hide this view and retry once per button.
  root.append(heading, detail, retry); // Add all elements to the overlay.
  root.hidden = false; // Show the overlay; CSS displays it when hidden is absent.
} // Finish the failure screen.
